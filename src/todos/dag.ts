import type { RunnerTask, RunnerPlan } from "./types.ts";
import type { ParsedTodosRunArgs } from "./types.ts";
import type { TodoItem } from "../todo.ts";
import { classifyTodo, isLockedClass, resolveRunnerForTask } from "./classify.ts";

export interface RunnerDagResult {
  tasks: RunnerTask[];
  batches: string[][];
  resourceLocks: Record<string, string[]>;
  errors: string[];
}

export { classifyTodo as classifyResourceClass, resolveRunnerForTask };

function labelFor(todo: TodoItem): string {
  return todo.id || todo.content;
}

export function buildRunnerDag(
  todos: TodoItem[],
  args: ParsedTodosRunArgs,
): RunnerDagResult {
  const errors: string[] = [];
  const selected = todos.filter((todo) => {
    if (!args.only || args.only.length === 0) return true;
    return args.only.includes(labelFor(todo)) || args.only.includes(todo.id) || args.only.includes(todo.content);
  });

  if (selected.length === 0) {
    errors.push("No matching todos to schedule.");
    return { tasks: [], batches: [], resourceLocks: {}, errors };
  }

  const tasks: RunnerTask[] = selected.map((todo) => {
    const label = labelFor(todo);
    const files = args.files?.[label];
    const resourceClass = classifyTodo(todo.content, files);
    const explicitDeps = args.deps?.[label] ?? [];
    const task: RunnerTask = {
      todoId: todo.id,
      label,
      content: todo.content,
      resourceClass,
      runner: resolveRunnerForTask(resourceClass),
      dependsOn: explicitDeps,
      model: args.model?.[label],
      files,
      status: "pending",
    };
    return task;
  });

  // Validate dependency labels before scheduling.
  const labelMap = new Map<string, RunnerTask>(tasks.map((task) => [task.label, task]));
  const errors2: string[] = [];
  for (const task of tasks) {
    if (task.dependsOn.includes(task.label)) {
      errors2.push(`Task "${task.label}" depends on itself.`);
      continue;
    }
    for (const dep of task.dependsOn) {
      if (!labelMap.has(dep)) errors2.push(`Task "${task.label}" depends on unknown label "${dep}".`);
    }
  }
  if (errors2.length > 0) {
    return { tasks, batches: [], resourceLocks: {}, errors: errors2 };
  }

  // Detect dependency cycles via colored DFS; a cycle refuses the whole run.
  const UNSEEN = 0;
  const IN_STACK = 1;
  const DONE = 2;
  const color = new Map<string, number>(tasks.map((task) => [task.label, UNSEEN]));
  let cyclePath: string[] | null = null;
  let cycleFound = false;  const dfs = (label: string, stack: string[]): boolean => {
    color.set(label, IN_STACK);
    stack.push(label);
    const task = labelMap.get(label);
    if (task) {
      for (const dep of task.dependsOn) {
        const state = color.get(dep) ?? UNSEEN;
        if (state === IN_STACK) {
          const start = stack.indexOf(dep);
          cyclePath = start >= 0 ? [...stack.slice(start), dep] : [...stack, dep];
          cycleFound = true;
          return true;
        }
        if (state === UNSEEN && dfs(dep, stack)) return true;
      }
    }
    stack.pop();
    color.set(label, DONE);
    return false;
  };
  for (const task of tasks) {
    if ((color.get(task.label) ?? UNSEEN) === UNSEEN) {
      const stack: string[] = [];
      if (dfs(task.label, stack)) break;
    }
  }
  if (cycleFound && cyclePath !== null) {
    const path = cyclePath as string[];
    return {
      tasks,
      batches: [],
      resourceLocks: {},
      errors: [`Dependency cycle detected: ${path.join(" → ")}.`],
    };
  }

  // Build batches:
  // - locked tasks (install/build/test/migration …) never share a batch;
  //   same-lock tasks stay consecutive in topological order.
  // - unlocked tasks run together when all of their deps are already placed.
  const batches: string[][] = [];
  const placed = new Set<string>();
  const isUnlocked = (label: string): boolean => {
    const task = labelMap.get(label);
    return !task || !isLockedClass(task.resourceClass);
  };
  let placedCount = 0;
  while (placedCount < tasks.length) {
    const readyUnlocked = tasks.filter((task) => {
      if (placed.has(task.label)) return false;
      if (!isUnlocked(task.label)) return false;
      return task.dependsOn.every((dep) => placed.has(dep));
    });
    const readyLocked = tasks.filter((task) => {
      if (placed.has(task.label) || !isLockedClass(task.resourceClass)) return false;
      return task.dependsOn.every((dep) => placed.has(dep));
    });
    if (readyLocked.length === 0) {
      if (readyUnlocked.length === 0) {
        errors.push("Could not form valid batches; dependency cycle or missing labels.");
        break;
      }
      batches.push(readyUnlocked.map((task) => task.label));
      for (const task of readyUnlocked) {
        placed.add(task.label);
        placedCount++;
      }
      continue;
    }
    // Pick the first ready locked task in declaration order so same-lock
    // tasks occupy consecutive solo batches without interleaving.
    const next = readyLocked[0]!;
    batches.push([next.label]);
    placed.add(next.label);
    placedCount++;
  }

  // resource locks: group locked task labels by their lock class
  const resourceLocks: Record<string, string[]> = {};
  for (const task of tasks) {
    if (isLockedClass(task.resourceClass)) {
      resourceLocks[task.resourceClass] = resourceLocks[task.resourceClass] ?? [];
      resourceLocks[task.resourceClass].push(task.label);
    }
  }

  return { tasks, batches, resourceLocks, errors };
}

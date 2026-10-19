// 任务分组工具：按标签批量操作
export async function killByTag(manager: any, tag: string) {
  const tasks = await manager.list();
  const targets = tasks.filter((t: any) => t.tags?.includes(tag));
  for (const t of targets) await manager.terminate(t.taskId);
  return { killed: targets.length, ids: targets.map((t: any) => t.taskId) };
}
export async function statusByTag(manager: any, tag: string) {
  const tasks = await manager.list();
  return tasks.filter((t: any) => t.tags?.includes(tag));
}

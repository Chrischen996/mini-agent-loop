import type { ExecutionPlan, ParsedPlan, RiskAssessment, ExecutionStep } from "./types.ts";
import { planManager } from "./plan-manager.ts";

/**
 * Generates execution plans from LLM output.
 */
export class PlanGenerator {
  /**
   * Parse LLM response into a structured plan.
   * 
   * Supports multiple formats:
   * 1. JSON object with plan structure
   * 2. Markdown with ## headings
   * 3. Hybrid: JSON block in markdown
   */
  parseFromLlmOutput(output: string, sessionId: string, summary?: string): ParsedPlan {
    // Try JSON first
    const jsonPlan = this.tryParseJson(output);
    if (jsonPlan.valid) {
      return jsonPlan;
    }

    // Try Markdown parsing
    const mdPlan = this.parseMarkdown(output, summary);
    if (mdPlan.valid) {
      return mdPlan;
    }

    // Return error
    return {
      valid: false,
      summary: summary ?? "Plan parsing failed",
      steps: [],
      risks: [],
      requiredTools: [],
      error: "Could not parse plan from LLM output. Expected JSON or Markdown format.",
    };
  }

  /**
   * Try to parse as JSON.
   */
  private tryParseJson(output: string): ParsedPlan {
    // Extract JSON from code blocks if present
    const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)\s*```/) 
      ?? output.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) return { valid: false, summary: "", steps: [], risks: [], requiredTools: [] };

    try {
      const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0]) as Partial<ExecutionPlan>;
      
    const steps: ExecutionStep[] = (parsed.steps ?? []).map((step, index) => ({
      id: step.id ?? `step_${index + 1}`,
      order: step.order ?? index + 1,
      description: step.description ?? step.tool ?? "Untitled step",
      tool: step.tool ?? "unknown",
      arguments: step.arguments ?? {},
      risk: ((step.risk ?? "medium") as "safe" | "medium" | "high"),
      rationale: step.rationale ?? "",
      status: ((step.status ?? "pending") as ExecutionStep["status"]),
    }));

      const risks: RiskAssessment[] = (parsed.risks ?? []).map((risk, index) => ({
        category: risk.category ?? "other",
        level: ((risk.level ?? "medium") as "low" | "medium" | "high" | "critical"),
        description: risk.description ?? "",
        mitigation: risk.mitigation ?? "",
      }));

      const requiredTools = [...new Set(steps.map((s) => s.tool))];

      return {
        valid: true,
        summary: parsed.summary ?? `Plan with ${steps.length} steps`,
        steps,
        risks,
        requiredTools,
      };
    } catch {
      return { valid: false, summary: "", steps: [], risks: [], requiredTools: [] };
    }
  }

  /**
   * Parse Markdown format plan.
   */
  private parseMarkdown(output: string, summary?: string): ParsedPlan {
    const lines = output.split("\n");
    const steps: ExecutionStep[] = [];
    const risks: RiskAssessment[] = [];
    const requiredTools = new Set<string>();
    
    let currentStep: Partial<ExecutionStep> | null = null;
    let currentRisk: Partial<RiskAssessment> | null = null;
    let inStepsSection = false;
    let inRisksSection = false;
    let stepOrder = 0;

    for (const line of lines) {
      const trimmed = line.trim();

      // Detect sections
      if (trimmed.startsWith("## ") || trimmed.startsWith("### ")) {
        const section = trimmed.replace(/^#+\s*/, "").toLowerCase();
        inStepsSection = section.includes("步骤") || section.includes("step");
        inRisksSection = section.includes("风险") || section.includes("risk");
        
        // Extract summary from heading if no summary provided
        if (!summary && !inStepsSection && !inRisksSection) {
          summary = trimmed.replace(/^#+\s*/, "");
        }
        continue;
      }

      // Parse steps
      if (inStepsSection && trimmed.match(/^\d+\.\s/)) {
        if (currentStep) {
          steps.push(this.finalizeStep(currentStep, stepOrder++));
        }
        currentStep = {
          description: trimmed.replace(/^\d+\.\s*/, ""),
          order: stepOrder,
          status: "pending",
        };
        continue;
      }

      // Parse step properties
      if (currentStep) {
        const toolMatch = trimmed.match(/^[-*]\s*工具[:：]?\s*(.+)$/i) 
          ?? trimmed.match(/^Tool[:：]?\s*(.+)$/i);
        if (toolMatch) {
          currentStep.tool = toolMatch[1]?.trim() ?? "unknown";
          requiredTools.add(currentStep.tool);
          continue;
        }

        const argsMatch = trimmed.match(/^[-*]\s*参数[:：]?\s*(.+)$/i)
          ?? trimmed.match(/^Arguments[:：]?\s*(.+)$/i);
        if (argsMatch) {
          try {
            currentStep.arguments = JSON.parse(argsMatch[1]?.trim() ?? "{}");
          } catch {
            currentStep.arguments = { raw: argsMatch[1] };
          }
          continue;
        }

        const riskMatch = trimmed.match(/^[-*]\s*风险[:：]?\s*(.+)$/i)
          ?? trimmed.match(/^Risk[:：]?\s*(.+)$/i);
        if (riskMatch) {
          currentStep.risk = this.parseRiskLevel(riskMatch[1]?.trim() ?? "medium");
          continue;
        }

        const rationaleMatch = trimmed.match(/^[-*]\s*原因[:：]?\s*(.+)$/i)
          ?? trimmed.match(/^Rationale[:：]?\s*(.+)$/i);
        if (rationaleMatch) {
          currentStep.rationale = rationaleMatch[1]?.trim() ?? "";
          continue;
        }
      }

      // Parse risks
      if (inRisksSection && trimmed.match(/^[-*]\s*\*?\*?([^*]+)\*?\*?\s*[:：]\s*(.+)$/)) {
        const match = trimmed.match(/^[-*]\s*\*?([^*]+)\*?\s*[:：]\s*(.+)$/);
        if (match) {
          currentRisk = {
            description: match[1]?.trim(),
            mitigation: match[2]?.trim() ?? "",
            level: "medium" as const,
            category: "other" as const,
          };
        }
        continue;
      }

      if (currentRisk && trimmed.startsWith("-")) {
        const propMatch = trimmed.match(/^\-\s*(\w+):\s*(.+)$/);
        if (propMatch) {
          const [, key, value] = propMatch;
          if (key === "level" || key === "Level") currentRisk.level = this.parseRiskLevel(value) as RiskAssessment["level"];
          if (key === "category" || key === "Category") currentRisk.category = this.parseRiskCategory(value);
          if (key === "mitigation" || key === "Mitigation") currentRisk.mitigation = value;
        } else if (!currentRisk.description && !currentRisk.mitigation) {
          currentRisk.description = trimmed.replace(/^\-\s*/, "");
        }
      }
    }

    // Finalize last step and risk
    if (currentStep) {
      steps.push(this.finalizeStep(currentStep, stepOrder));
    }
    if (currentRisk) {
      risks.push(currentRisk as RiskAssessment);
    }

    return {
      valid: steps.length > 0,
      summary: summary ?? `Plan with ${steps.length} steps`,
      steps,
      risks,
      requiredTools: [...requiredTools],
    };
  }

  /**
   * Finalize a step with defaults.
   */
  private finalizeStep(step: Partial<ExecutionStep>, order: number): ExecutionStep {
    return {
      id: step.id ?? `step_${order + 1}`,
      order: step.order ?? order + 1,
      description: step.description ?? "Untitled step",
      tool: step.tool ?? "unknown",
      arguments: step.arguments ?? {},
      risk: step.risk ?? "medium",
      rationale: step.rationale ?? "",
      status: step.status ?? "pending",
    };
  }

  /**
   * Parse risk level from text.
   */
  private parseRiskLevel(text: string): "safe" | "medium" | "high" {
    const lower = text.toLowerCase();
    if (lower.includes("safe") || lower.includes("低") || lower.includes("min")) return "safe";
    if (lower.includes("high") || lower.includes("高") || lower.includes("max")) return "high";
    return "medium";
  }

  /**
   * Parse risk category from text.
   */
  private parseRiskCategory(text: string): import("./types.ts").RiskCategory {
    const lower = text.toLowerCase();
    if (lower.includes("file") || lower.includes("文件") || lower.includes("modification")) return "file_modification";
    if (lower.includes("command") || lower.includes("命令") || lower.includes("execution")) return "command_execution";
    if (lower.includes("network") || lower.includes("网络") || lower.includes("access")) return "network_access";
    if (lower.includes("mcp")) return "mcp_tool";
    if (lower.includes("delete") || lower.includes("删除")) return "data_deletion";
    return "other";
  }

  /**
   * Generate a plan from LLM output and store it.
   */
  generateAndStore(output: string, sessionId: string, summary?: string): ExecutionPlan | null {
    const parsed = this.parseFromLlmOutput(output, sessionId, summary);
    
    if (!parsed.valid) {
      console.error("[PlanGenerator] Failed to parse plan:", parsed.error);
      return null;
    }

    const plan = planManager.createPlan(sessionId, parsed.summary, parsed.steps as ExecutionStep[]);
    
    // Update with parsed risks
    if (parsed.risks.length > 0) {
      plan.risks = parsed.risks;
    }
    if (parsed.requiredTools.length > 0) {
      plan.requiredTools = parsed.requiredTools;
    }

    // Mark as pending review
    planManager.markPendingReview(plan.id);

    return plan;
  }

  /**
   * Create a simple plan programmatically.
   */
  createSimplePlan(
    sessionId: string,
    summary: string,
    steps: Array<{
      tool: string;
      description: string;
      arguments?: Record<string, unknown>;
      risk?: "safe" | "medium" | "high";
      rationale?: string;
    }>,
  ): ExecutionPlan {
    const planSteps: ExecutionStep[] = steps.map((step, index) => ({
      id: `step_${index + 1}`,
      order: index + 1,
      description: step.description,
      tool: step.tool,
      arguments: step.arguments ?? {},
      risk: step.risk ?? "medium",
      rationale: step.rationale ?? "",
      status: "pending",
    }));

    const plan = planManager.createPlan(sessionId, summary, planSteps);
    planManager.markPendingReview(plan.id);
    return plan;
  }
}

/**
 * Singleton instance for global access.
 */
export const planGenerator = new PlanGenerator();

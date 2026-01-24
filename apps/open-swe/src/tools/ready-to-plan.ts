import { tool } from "@langchain/core/tools";
import { z } from "zod";

// Define the schema locally to avoid import issues before build
const readyToPlanSchema = z.object({
    reasoning: z
        .string()
        .describe(
            "Explain why you have gathered enough context and are ready to generate the plan. " +
            "Include a brief summary of the key information you've discovered that will inform the plan.",
        ),
    key_findings: z
        .array(z.string())
        .optional()
        .describe(
            "Optional list of key findings or important context gathered during research. " +
            "These will be preserved for use in plan generation.",
        ),
});

const readyToPlanToolFields = {
    name: "ready_to_plan",
    description:
        "Call this tool when you have gathered sufficient context about the codebase and are ready to generate " +
        "an execution plan. This signals the transition from context-gathering phase to plan generation phase. " +
        "You should call this ONLY when you are confident you have enough information to create a detailed, actionable plan.",
    schema: readyToPlanSchema,
};

/**
 * Creates a tool that allows the AI to signal when it has gathered enough context
 * and is ready to generate a plan. This enables AI-driven transition from
 * context-gathering to plan generation.
 */
export function createReadyToPlanTool() {
    const readyToPlanTool = tool(
        async (
            input: z.infer<typeof readyToPlanSchema>,
        ): Promise<{ result: string; status: "success" | "error" }> => {
            // The tool itself doesn't do anything - it's a signal
            // The reasoning and key_findings are captured in the tool call args
            // and can be used by the notetaker/generate-plan nodes
            return {
                result: `Successfully signaled ready to plan. Reasoning: ${input.reasoning}`,
                status: "success",
            };
        },
        readyToPlanToolFields,
    );

    return readyToPlanTool;
}

// Export the tool name for use in routing logic
export const READY_TO_PLAN_TOOL_NAME = "ready_to_plan";

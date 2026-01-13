import { GraphConfig, ImageDescription } from "@openswe/shared/open-swe/types";
import { getModelManager } from "./llms/model-manager.js";
import { LLMTask } from "@openswe/shared/open-swe/llm-task";
import { HumanMessage } from "@langchain/core/messages";
import { createLogger, LogLevel } from "./logger.js";

const logger = createLogger(LogLevel.INFO, "ImageDescriptionGenerator");

/**
 * Prompt for generating comprehensive image descriptions.
 * The description should be detailed enough to serve as a reference
 * when the actual image is not available in subsequent turns.
 */
const IMAGE_DESCRIPTION_PROMPT = `Analyze this image and provide a comprehensive description for an AI coding assistant.

Include the following aspects in your description:
1. **Type of content**: UI mockup, screenshot, diagram, flowchart, photo, icon, etc.
2. **Layout and structure**: Overall organization, sections, grid/flex patterns
3. **Visual elements**: Buttons, forms, cards, navigation, modals, etc.
4. **Text and labels**: Any visible text, headings, button labels, placeholders
5. **Colors and styling**: Color scheme, typography, shadows, borders, gradients
6. **Data and content**: Sample data, table structures, list items
7. **Technical details**: If code/terminal is visible, summarize key content
8. **Responsive hints**: Mobile/desktop layout indicators if apparent

Be thorough but concise. This description will replace the actual image in subsequent references.
Focus on details that would be important for implementing or understanding this image in a coding context.

Respond with ONLY the description, no preamble or explanation.`;

/**
 * Generate a detailed text description of an image using a vision-capable model.
 * This description will be cached and used in subsequent turns to reduce context size.
 * 
 * @param base64DataUrl - The image as a base64 data URL (e.g., "data:image/png;base64,...")
 * @param imagePath - Original path to the image file
 * @param config - GraphConfig for loading the appropriate model
 * @returns Promise<ImageDescription> - The generated description with metadata
 */
export async function generateImageDescription(
    base64DataUrl: string,
    imagePath: string,
    config: GraphConfig
): Promise<ImageDescription> {
    const startTime = Date.now();

    logger.info("Generating image description", {
        imagePath,
        dataUrlLength: base64DataUrl.length,
    });

    try {
        // Use router model (fast, cheap) for description generation
        // Most router models support vision (Claude Haiku, GPT-4o-mini, Gemini Flash)
        const modelManager = getModelManager();
        const model = await modelManager.loadModel(config, LLMTask.ROUTER);

        // Create multimodal message with image and prompt
        const message = new HumanMessage({
            content: [
                {
                    type: "image_url",
                    image_url: { url: base64DataUrl },
                },
                {
                    type: "text",
                    text: IMAGE_DESCRIPTION_PROMPT,
                },
            ],
        });

        // Invoke the model
        const response = await model.invoke([message]);

        // Extract the text content from response
        const description = typeof response.content === "string"
            ? response.content
            : Array.isArray(response.content)
                ? response.content
                    .filter((c): c is { type: "text"; text: string } =>
                        typeof c === "object" && c !== null && "type" in c && c.type === "text")
                    .map(c => c.text)
                    .join("\n")
                : String(response.content);

        const generationTime = Date.now() - startTime;

        logger.info("Image description generated successfully", {
            imagePath,
            descriptionLength: description.length,
            generationTimeMs: generationTime,
        });

        return {
            description,
            imagePath,
            generatedAt: Date.now(),
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error("Failed to generate image description", {
            imagePath,
            error: errorMessage,
        });

        // Return a fallback description on error
        return {
            description: `[Image at ${imagePath} - description generation failed: ${errorMessage}]`,
            imagePath,
            generatedAt: Date.now(),
        };
    }
}

/**
 * Generate image description asynchronously (fire-and-forget).
 * Used to cache descriptions in the background while returning base64 immediately on first read.
 * 
 * @param base64DataUrl - The image as a base64 data URL
 * @param imagePath - Original path to the image file
 * @param config - GraphConfig for loading the appropriate model
 * @param onComplete - Callback to update state with the generated description
 */
export async function generateImageDescriptionAsync(
    base64DataUrl: string,
    imagePath: string,
    config: GraphConfig,
    onComplete?: (description: ImageDescription) => void
): Promise<void> {
    try {
        const description = await generateImageDescription(base64DataUrl, imagePath, config);

        if (onComplete) {
            onComplete(description);
        }

        logger.info("Async image description generation completed", {
            imagePath,
            descriptionLength: description.description.length,
        });
    } catch (error) {
        logger.error("Async image description generation failed", {
            imagePath,
            error: error instanceof Error ? error.message : String(error),
        });
        // Silently fail for async generation - next read will try again
    }
}

/**
 * Format a cached image description for display in a tool message.
 * This format helps the AI understand it's a reference to a previously analyzed image.
 * 
 * @param imageDescription - The cached image description
 * @returns Formatted string for tool message content
 */
export function formatCachedImageDescription(imageDescription: ImageDescription): string {
    const timestamp = new Date(imageDescription.generatedAt).toISOString();

    return `📷 **Previously Analyzed Image**: \`${imageDescription.imagePath}\`
*(Analyzed at ${timestamp} - using cached description to reduce context size)*

---

${imageDescription.description}

---

*Note: If you need to see the actual image again (e.g., for detailed pixel-level analysis), you can call read_image with force_reload=true.*`;
}

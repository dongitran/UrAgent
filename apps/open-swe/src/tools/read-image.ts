import { join, isAbsolute, extname } from "path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { GraphState, GraphConfig } from "@openswe/shared/open-swe/types";
import { createLogger, LogLevel } from "../utils/logger.js";
import { getRepoAbsolutePath } from "@openswe/shared/git";
import { getSandboxInstanceOrThrow } from "./utils/get-sandbox-id.js";
import {
    isLocalMode,
    getLocalWorkingDirectory,
} from "@openswe/shared/open-swe/local-mode";
import * as fs from "fs/promises";

const logger = createLogger(LogLevel.INFO, "ReadImageTool");

/**
 * Supported image extensions and their MIME types
 */
const IMAGE_MIME_TYPES: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
};

/**
 * Get MIME type from file extension
 */
function getMimeType(filePath: string): string {
    const ext = extname(filePath).toLowerCase();
    return IMAGE_MIME_TYPES[ext] || "application/octet-stream";
}

/**
 * Check if file is a supported image
 */
function isSupportedImage(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase();
    return ext in IMAGE_MIME_TYPES;
}

/**
 * Creates a tool for reading images from the sandbox/local filesystem.
 * Returns image content as base64 data URL that can be used in multimodal prompts.
 * 
 * Supported formats: PNG, JPG, JPEG, GIF, WEBP, HEIC, HEIF, SVG, BMP, ICO
 * (Note: HEIC/HEIF support varies by AI model)
 * 
 * @example
 * Agent can use this tool to read UI reference images:
 * ```
 * read_image({ path: "designs/login-page.png" })
 * // Returns: "data:image/png;base64,iVBORw0KGgo..."
 * ```
 * 
 * The returned base64 data URL can be included in HumanMessage content
 * as an image_url block for multimodal models like Gemini.
 */
export function createReadImageTool(
    state: Pick<GraphState, "sandboxSessionId" | "targetRepository"> & { sandboxProviderType?: string },
    config: GraphConfig,
) {
    const readImageTool = tool(
        async (input): Promise<{ result: string; status: "success" | "error" }> => {
            try {
                const { path: inputPath, workdir: inputWorkdir } = input as {
                    path: string;
                    workdir?: string;
                };

                // Validate it's an image file
                if (!isSupportedImage(inputPath)) {
                    const supportedFormats = Object.keys(IMAGE_MIME_TYPES).join(", ");
                    throw new Error(
                        `Unsupported image format: ${extname(inputPath)}. Supported formats: ${supportedFormats}`
                    );
                }

                const repoRoot = isLocalMode(config)
                    ? getLocalWorkingDirectory()
                    : getRepoAbsolutePath(state.targetRepository, undefined, state.sandboxProviderType);

                let workDir = repoRoot;
                if (inputWorkdir) {
                    workDir = isAbsolute(inputWorkdir)
                        ? inputWorkdir
                        : join(repoRoot, inputWorkdir);
                }

                // Build full path
                const fullPath = isAbsolute(inputPath)
                    ? inputPath
                    : join(workDir, inputPath);

                logger.info("Reading image file", {
                    inputPath,
                    fullPath,
                    workDir,
                    isLocalMode: isLocalMode(config),
                });


                if (isLocalMode(config)) {
                    // Read from local filesystem
                    const imageData = await fs.readFile(fullPath);
                    const mimeType = getMimeType(fullPath);
                    const base64 = imageData.toString("base64");
                    const dataUrl = `data:${mimeType};base64,${base64}`;

                    logger.info("Image read successfully from local filesystem", {
                        path: fullPath,
                        mimeType,
                        dataUrlLength: dataUrl.length,
                    });

                    return { result: dataUrl, status: "success" };
                } else {
                    // Read from sandbox
                    const sandboxInstance = await getSandboxInstanceOrThrow({
                        xSandboxSessionId: state.sandboxSessionId,
                    });

                    // Properly escape the path for shell execution to prevent injection
                    // Replace ' with '\'' and wrap in single quotes
                    const escapedPath = `'${fullPath.replace(/'/g, "'\\''")}'`;

                    // readFile returns string - need to convert
                    // For binary files, we use base64 command in sandbox
                    const result = await sandboxInstance.executeCommand({
                        command: `base64 -w 0 ${escapedPath}`,
                        workdir: workDir,
                    });

                    if (result.exitCode !== 0) {
                        throw new Error(`Failed to read image (exit code ${result.exitCode}): ${result.result}`);
                    }

                    // Result is already base64 encoded
                    const mimeType = getMimeType(fullPath);
                    const dataUrl = `data:${mimeType};base64,${result.result.trim()}`;

                    logger.info("Image read successfully from sandbox", {
                        path: fullPath,
                        mimeType,
                        dataUrlLength: dataUrl.length,
                    });

                    return { result: dataUrl, status: "success" };
                }
            } catch (error) {
                const errorMessage =
                    error instanceof Error ? error.message : String(error);
                logger.error(`Failed to read image: ${errorMessage}`);
                return {
                    result: `Error reading image: ${errorMessage}`,
                    status: "error",
                };
            }
        },
        {
            name: "read_image",
            description: `Read an image file from the repository and return it as base64 data URL.
Use this tool when you need to:
- View UI mockups or design references to implement UI components
- Analyze screenshots or diagrams in the codebase
- Reference existing image assets

The returned base64 data URL can be processed by vision-capable AI models.

Supported formats: PNG, JPG, JPEG, GIF, WEBP, HEIC, HEIF, SVG, BMP, ICO

Example paths:
- "designs/login-page.png" - relative to repo root
- "src/assets/logo.svg" - relative path
- "/home/daytona/project/repo/image.png" - absolute path`,
            schema: z.object({
                path: z.string().describe("Path to the image file (relative to workdir or absolute)"),
                workdir: z.string().optional().describe("Working directory (defaults to repository root)"),
            }),
        }
    );

    return readImageTool;
}

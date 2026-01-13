import { join, isAbsolute, extname } from "path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { GraphState, GraphConfig, ImageDescription } from "@openswe/shared/open-swe/types";
import { createLogger, LogLevel } from "../utils/logger.js";
import { getRepoAbsolutePath } from "@openswe/shared/git";
import { getSandboxInstanceOrThrow } from "./utils/get-sandbox-id.js";
import {
    isLocalMode,
    getLocalWorkingDirectory,
} from "@openswe/shared/open-swe/local-mode";
import * as fs from "fs/promises";
import { formatCachedImageDescription } from "../utils/image-description-generator.js";

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
 * Return type for read_image tool with hybrid analysis support.
 * Contains additional metadata for caching and processing.
 */
export interface ReadImageResult {
    /** The result content - either base64 data URL or cached description */
    result: string;
    /** Status of the operation */
    status: "success" | "error";
    /** Whether this is the first time reading this image (cache miss) */
    isFirstRead?: boolean;
    /** The normalized path used as cache key */
    imagePath?: string;
    /** The base64 data URL (only present on first read for caching) */
    base64DataUrl?: string;
}

/**
 * Creates a tool for reading images from the sandbox/local filesystem.
 * 
 * **Hybrid Image Analysis**:
 * - First read: Returns base64 data URL for visual analysis + triggers background description generation
 * - Subsequent reads: Returns cached text description to reduce context size (~99% reduction)
 * 
 * Supported formats: PNG, JPG, JPEG, GIF, WEBP, HEIC, HEIF, SVG, BMP, ICO
 * (Note: HEIC/HEIF support varies by AI model)
 * 
 * @example
 * Agent can use this tool to read UI reference images:
 * ```
 * read_image({ path: "designs/login-page.png" })
 * // First read returns: "data:image/png;base64,iVBORw0KGgo..." (~500KB)
 * // Subsequent reads return: "[Previously analyzed image...]" (~1-2KB)
 * ```
 * 
 * The returned base64 data URL can be included in HumanMessage content
 * as an image_url block for multimodal models like Gemini.
 */
export function createReadImageTool(
    state: Pick<GraphState, "sandboxSessionId" | "targetRepository"> & {
        sandboxProviderType?: string;
        imageDescriptionCache?: Record<string, ImageDescription>;
    },
    config: GraphConfig,
) {
    const readImageTool = tool(
        async (input): Promise<ReadImageResult> => {
            try {
                const { path: inputPath, workdir: inputWorkdir, force_reload: forceReload } = input as {
                    path: string;
                    workdir?: string;
                    force_reload?: boolean;
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

                // Build full path - used as cache key
                const fullPath = isAbsolute(inputPath)
                    ? inputPath
                    : join(workDir, inputPath);

                // ===============================================================
                // HYBRID IMAGE ANALYSIS: Check cache first (unless force_reload)
                // ===============================================================
                const cachedDescription: ImageDescription | undefined =
                    state.imageDescriptionCache?.[fullPath];

                if (cachedDescription && !forceReload) {
                    logger.info("Using cached image description (hybrid mode)", {
                        imagePath: fullPath,
                        cachedAt: new Date(cachedDescription.generatedAt).toISOString(),
                        descriptionLength: cachedDescription.description.length,
                        contextSavings: "~99% reduction",
                    });

                    // Serialize as JSON so processToolCallContent can parse it
                    const cacheHitResult: ReadImageResult = {
                        result: formatCachedImageDescription(cachedDescription),
                        status: "success",
                        isFirstRead: false,
                        imagePath: fullPath,
                    };

                    return {
                        result: JSON.stringify(cacheHitResult),
                        status: "success",
                    };
                }

                // ===============================================================
                // CACHE MISS: Read actual image from filesystem/sandbox
                // ===============================================================
                logger.info("Reading image file (first read - will cache description)", {
                    inputPath,
                    fullPath,
                    workDir,
                    isLocalMode: isLocalMode(config),
                    forceReload,
                });

                let dataUrl: string;

                if (isLocalMode(config)) {
                    // Read from local filesystem
                    const imageData = await fs.readFile(fullPath);
                    const mimeType = getMimeType(fullPath);
                    const base64 = imageData.toString("base64");
                    dataUrl = `data:${mimeType};base64,${base64}`;

                    logger.info("Image read successfully from local filesystem", {
                        path: fullPath,
                        mimeType,
                        dataUrlLength: dataUrl.length,
                    });
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
                    dataUrl = `data:${mimeType};base64,${result.result.trim()}`;

                    logger.info("Image read successfully from sandbox", {
                        path: fullPath,
                        mimeType,
                        dataUrlLength: dataUrl.length,
                    });
                }

                // Serialize as JSON so processToolCallContent can parse it
                // The full ReadImageResult with metadata is stored in .result field
                const firstReadResult: ReadImageResult = {
                    result: dataUrl,
                    status: "success",
                    isFirstRead: true,
                    imagePath: fullPath,
                    base64DataUrl: dataUrl,
                };

                return {
                    result: JSON.stringify(firstReadResult),
                    status: "success",
                };
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
            description: `Read an image file from the repository and return it for visual analysis.

**Hybrid Mode**: First read returns the actual image (base64), subsequent reads return a cached text description to save context space (~99% reduction in context size).

Use this tool when you need to:
- View UI mockups or design references to implement UI components
- Analyze screenshots or diagrams in the codebase
- Reference existing image assets

The returned content can be processed by vision-capable AI models.

Supported formats: PNG, JPG, JPEG, GIF, WEBP, HEIC, HEIF, SVG, BMP, ICO

Example paths:
- "designs/login-page.png" - relative to repo root
- "src/assets/logo.svg" - relative path
- "/home/daytona/project/repo/image.png" - absolute path`,
            schema: z.object({
                path: z.string().describe("Path to the image file (relative to workdir or absolute)"),
                workdir: z.string().optional().describe("Working directory (defaults to repository root)"),
                force_reload: z.boolean().optional().describe("Force reload the actual image instead of using cached description (use when you need fresh visual analysis)"),
            }),
        }
    );

    return readImageTool;
}

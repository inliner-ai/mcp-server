#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const zod_1 = require("zod");
const API_BASE = process.env.INLINER_API_URL || "https://api.inliner.ai";
const IMG_BASE = "https://img.inliner.ai";
const DEFAULT_PROJECT = process.env.INLINER_DEFAULT_PROJECT;
const IMAGE_MODEL_VALUES = [
    "IMAGE_GEN_Z_IMAGE_TURBO",
    "IMAGE_GEN_QWEN_IMAGE",
    "IMAGE_GEN_NANO_BANANA_LITE",
    "IMAGE_GEN_FLUX_PRO",
    "IMAGE_GEN_GPT_IMAGE_2",
    "IMAGE_GEN_KREA_2_MEDIUM",
    "IMAGE_GEN_RECRAFT_V4_1_UTILITY",
    "IMAGE_GEN_RECRAFT_V4_1_UTILITY_PRO",
    "IMAGE_GEN_RECRAFT_V3",
    "IMAGE_GEN_NANO_BANANA",
    "IMAGE_GEN_RUNWAY_GEN4",
];
const imageGenerationModeInput = zod_1.z
    .enum(["auto", "cheap"])
    .default("auto")
    .describe("Routing policy. cheap automatically chooses Z-Image, Qwen, or Gemini Flash Lite by capability.");
const imageModelInput = zod_1.z
    .enum(IMAGE_MODEL_VALUES)
    .optional()
    .describe("Optional exact model override. When provided, it takes priority over mode.");
function getApiKey() {
    const key = process.env.INLINER_API_KEY ||
        process.argv.find((a) => a.startsWith("--api-key="))?.split("=")[1];
    if (!key) {
        console.error("Error: INLINER_API_KEY environment variable or --api-key argument required");
        process.exit(1);
    }
    return key;
}
async function apiFetch(path, apiKey, options) {
    const url = `${API_BASE}/${path}`;
    const res = await fetch(url, {
        ...options,
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            ...(options?.headers || {}),
        },
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`API error ${res.status}: ${body}`);
    }
    return res.json();
}
function sanitizeSlug(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 100);
}
function buildImageUrl(project, slug, format, fullPath) {
    const path = fullPath && fullPath.trim().length > 0
        ? fullPath.replace(/^\//, "")
        : `${project}/${slug}.${format}`;
    return `${IMG_BASE}/${path}`;
}
function parseDataUrlToBuffer(dataUrl) {
    if (!dataUrl || typeof dataUrl !== "string")
        return null;
    if (!dataUrl.startsWith("data:"))
        return null;
    const parts = dataUrl.split(",", 2);
    if (parts.length !== 2 || !parts[1])
        return null;
    return Buffer.from(parts[1], "base64");
}
async function recommendSmartSlug(project, prompt, width, height, extension, apiKey) {
    try {
        return await apiFetch("url/recommend", apiKey, {
            method: "POST",
            body: JSON.stringify({
                prompt,
                project,
                width,
                height,
                extension,
            }),
        });
    }
    catch {
        return null;
    }
}
async function generateContentWithSmartSlug(project, prompt, width, height, format, apiKey, smartUrl = true, mode = "auto", model) {
    const recommendation = smartUrl
        ? await recommendSmartSlug(project, prompt, width, height, format, apiKey)
        : null;
    const fallbackSlug = sanitizeSlug(prompt);
    const selectedSlug = recommendation?.recommendedSlug || fallbackSlug;
    const generationResponse = await apiFetch("content/generate", apiKey, {
        method: "POST",
        body: JSON.stringify({
            prompt,
            project,
            slug: selectedSlug,
            width,
            height,
            extension: format,
            mode,
            model,
        }),
    });
    const contentPath = typeof generationResponse?.prompt === "string" && generationResponse.prompt.length > 0
        ? generationResponse.prompt.replace(/^\//, "")
        : `${project}/${selectedSlug}.${format}`;
    const url = `${IMG_BASE}/${contentPath}`;
    const html = `<img src="${url}" alt="${prompt.replace(/-/g, " ")}" width="${width}" height="${height}" loading="lazy" />`;
    const inlineData = parseDataUrlToBuffer(generationResponse?.mediaAsset?.data);
    if (inlineData) {
        return {
            url,
            html,
            imageBuffer: inlineData,
            contentPath,
            recommendedSlug: recommendation?.recommendedSlug,
            alternativeSlugs: recommendation?.alternativeSlugs || [],
        };
    }
    const fetched = await fetch(url, {
        headers: {
            Authorization: `Bearer ${apiKey}`,
        },
    });
    if (!fetched.ok) {
        throw new Error(`Failed to fetch generated image (${fetched.status}) from ${url}`);
    }
    return {
        url,
        html,
        imageBuffer: Buffer.from(await fetched.arrayBuffer()),
        contentPath,
        recommendedSlug: recommendation?.recommendedSlug,
        alternativeSlugs: recommendation?.alternativeSlugs || [],
    };
}
async function resolveProject(project, apiKey) {
    if (project && project.trim().length > 0)
        return project.trim();
    if (DEFAULT_PROJECT && DEFAULT_PROJECT.trim().length > 0)
        return DEFAULT_PROJECT.trim();
    try {
        const data = await apiFetch("account/projects", apiKey);
        const projects = data?.projects || [];
        if (projects.length > 0) {
            const defaultProject = projects.find((p) => p.isDefault === 1 || p.isDefault === true);
            if (defaultProject?.project)
                return defaultProject.project;
            if (projects[0]?.project)
                return projects[0].project;
        }
    }
    catch {
        // fall through
    }
    return "default";
}
// --- Server setup ---
const MCP_INSTRUCTIONS = `Use Inliner when the user requests a new or edited visual asset for code, UI, email, documentation, ecommerce, or marketing content. For a new asset, call generate_image so the account-owned URL is materialized before it is inserted. Use mode=cheap when the user asks for a low-cost or budget render; it automatically selects Z-Image, Qwen, or Gemini Flash Lite. Use model only when the user requests an exact model; an explicit model takes priority over mode. For a change to an identified existing asset, call edit_image. Use recommend_image_url only when the user explicitly wants a slug or URL recommendation; it does not generate an image. Resolve projects automatically and never create a project without user intent. Existing generated URLs may be embedded directly. Include useful dimensions and semantic alt text in code.`;
const server = new mcp_js_1.McpServer({
    name: "inliner",
    version: "1.2.0",
}, {
    instructions: MCP_INSTRUCTIONS,
});
const apiKey = getApiKey();
function toolResult(payload) {
    const structuredContent = payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? payload
        : { data: payload };
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(payload, null, 2),
            },
        ],
        structuredContent,
    };
}
// --- Tools ---
const imageUrlInput = {
    project: zod_1.z
        .string()
        .optional()
        .describe("Project namespace. Omit to use the configured or account default."),
    description: zod_1.z
        .string()
        .describe("Detailed visual description used to recommend a concise URL slug."),
    width: zod_1.z
        .number()
        .min(100)
        .max(4096)
        .describe("Recommended image width in pixels (100-4096)."),
    height: zod_1.z
        .number()
        .min(100)
        .max(4096)
        .describe("Recommended image height in pixels (100-4096)."),
    format: zod_1.z
        .enum(["png", "jpg"])
        .default("png")
        .describe("Recommended format: png for graphics/transparency or jpg for photos."),
    smartUrl: zod_1.z
        .boolean()
        .default(true)
        .describe("Use Inliner's concise smart-slug recommendation."),
};
async function recommendImageUrl({ project, description, width, height, format, smartUrl, edit, }) {
    const resolvedProject = await resolveProject(project, apiKey);
    const recommendation = smartUrl
        ? await recommendSmartSlug(resolvedProject, description, width, height, format, apiKey)
        : null;
    const fallbackSlug = sanitizeSlug(description);
    const selectedSlug = recommendation?.recommendedSlug || fallbackSlug;
    let url = buildImageUrl(resolvedProject, selectedSlug, format, recommendation?.fullPath);
    if (edit) {
        const sanitizedEdit = sanitizeSlug(edit);
        url += `/${sanitizedEdit}.${format}`;
    }
    const html = `<img src="${url}" alt="${description.replace(/-/g, " ")}" width="${width}" height="${height}" loading="lazy" />`;
    return toolResult({
        url,
        html,
        generated: false,
        warning: "This tool recommends a URL only. Call generate_image before inserting a new account-owned asset.",
        smartUrlUsed: smartUrl,
        project: resolvedProject,
        recommendedSlug: recommendation?.recommendedSlug || selectedSlug,
        alternativeSlugs: recommendation?.alternativeSlugs || [],
    });
}
server.tool("recommend_image_url", "Recommend a concise Inliner URL and HTML snippet without generating an image. Use only when the user explicitly wants naming or URL planning; use generate_image for a new asset that will be inserted or shipped.", imageUrlInput, recommendImageUrl);
server.tool("generate_image_url", "Deprecated compatibility alias for recommend_image_url. It recommends a URL but does not generate the image. Prefer generate_image for new assets and edit_image for changes to existing assets.", {
    ...imageUrlInput,
    edit: zod_1.z
        .string()
        .optional()
        .describe("Deprecated URL-only edit suffix. Prefer edit_image with an explicit source."),
}, recommendImageUrl);
server.tool("generate_image", "Generate and host a new Inliner image, returning a materialized CDN URL and optional local file. Use for every new asset that will be inserted, shipped, or verified. This operation consumes generation credits.", {
    project: zod_1.z
        .string()
        .optional()
        .describe("Project namespace from Inliner dashboard (e.g. 'my-project')"),
    description: zod_1.z
        .string()
        .describe("Hyphenated image description (e.g. 'modern-office-team-meeting')"),
    width: zod_1.z
        .number()
        .min(100)
        .max(4096)
        .describe("Image width in pixels (100-4096)"),
    height: zod_1.z
        .number()
        .min(100)
        .max(4096)
        .describe("Image height in pixels (100-4096)"),
    format: zod_1.z
        .enum(["png", "jpg"])
        .default("png")
        .describe("Image format: png (transparency) or jpg (photos)"),
    outputPath: zod_1.z
        .string()
        .optional()
        .describe("Optional local file path to save the image (e.g. './images/hero.png')"),
    smartUrl: zod_1.z
        .boolean()
        .default(true)
        .describe("Use smart URL recommendation for concise, readable slugs"),
    mode: imageGenerationModeInput,
    model: imageModelInput,
}, async ({ project, description, width, height, format, outputPath, smartUrl, mode, model }) => {
    const resolvedProject = await resolveProject(project, apiKey);
    const generated = await generateContentWithSmartSlug(resolvedProject, description, width, height, format, apiKey, smartUrl, mode, model);
    if (outputPath) {
        const fs = await import("fs/promises");
        const path = await import("path");
        // Create directory if it doesn't exist
        const dir = path.dirname(outputPath);
        await fs.mkdir(dir, { recursive: true });
        // Write file
        await fs.writeFile(outputPath, generated.imageBuffer);
    }
    return toolResult({
        url: generated.url,
        html: generated.html,
        generated: true,
        saved: Boolean(outputPath),
        outputPath: outputPath || null,
        size: generated.imageBuffer.byteLength,
        smartUrlUsed: smartUrl,
        project: resolvedProject,
        recommendedSlug: generated.recommendedSlug || null,
        alternativeSlugs: generated.alternativeSlugs || [],
        mode,
        model: model || null,
    });
});
server.tool("create_image", "Deprecated compatibility alias for generate_image with 800x600 PNG defaults. Prefer generate_image so dimensions and format reflect the actual layout. This operation consumes generation credits.", {
    description: zod_1.z
        .string()
        .describe("Image description (e.g., 'happy-duck', 'modern-office-hero')"),
    project: zod_1.z
        .string()
        .optional()
        .describe("Project namespace (defaults to first available project if not specified)"),
    width: zod_1.z
        .number()
        .min(100)
        .max(4096)
        .default(800)
        .optional()
        .describe("Image width in pixels (default: 800)"),
    height: zod_1.z
        .number()
        .min(100)
        .max(4096)
        .default(600)
        .optional()
        .describe("Image height in pixels (default: 600)"),
    format: zod_1.z
        .enum(["png", "jpg"])
        .default("png")
        .optional()
        .describe("Image format (default: png)"),
    outputPath: zod_1.z
        .string()
        .optional()
        .describe("Optional local file path to save the image (e.g., './images/hero.png')"),
    smartUrl: zod_1.z
        .boolean()
        .default(true)
        .optional()
        .describe("Use smart URL recommendation for concise, readable slugs"),
    mode: imageGenerationModeInput.optional(),
    model: imageModelInput,
}, async ({ description, project, width = 800, height = 600, format = "png", outputPath, smartUrl = true, mode = "auto", model }) => {
    const finalProject = await resolveProject(project, apiKey);
    const generated = await generateContentWithSmartSlug(finalProject, description, width, height, format, apiKey, smartUrl, mode, model);
    // Save to file if outputPath is provided
    if (outputPath) {
        const fs = await import("fs/promises");
        const path = await import("path");
        // Create directory if it doesn't exist
        const dir = path.dirname(outputPath);
        await fs.mkdir(dir, { recursive: true });
        // Write file
        await fs.writeFile(outputPath, generated.imageBuffer);
    }
    return toolResult({
        url: generated.url,
        html: generated.html,
        generated: true,
        deprecatedAlias: "create_image",
        saved: Boolean(outputPath),
        outputPath: outputPath || null,
        size: generated.imageBuffer.byteLength,
        project: finalProject,
        smartUrlUsed: smartUrl,
        recommendedSlug: generated.recommendedSlug || null,
        alternativeSlugs: generated.alternativeSlugs || [],
        mode,
        model: model || null,
    });
});
server.tool("edit_image", "Edit an explicitly identified existing image by Inliner URL or local path, optionally resize it, and return a materialized CDN URL or local file. Use for change, resize, restyle, or remove-background requests when a source image exists. This operation consumes edit credits.", {
    sourceUrl: zod_1.z
        .string()
        .optional()
        .describe("Source image URL (e.g., 'https://img.inliner.ai/project/image_800x800.png')"),
    sourcePath: zod_1.z
        .string()
        .optional()
        .describe("Optional local file path to upload and edit (e.g., '/tmp/photo.png')"),
    project: zod_1.z
        .string()
        .optional()
        .describe("Project namespace used when uploading a local file"),
    uploadPrompt: zod_1.z
        .string()
        .optional()
        .describe("Optional prompt/filename for uploaded image (no slashes)"),
    editInstruction: zod_1.z
        .string()
        .describe("Edit instruction (e.g., 'make-it-blue', 'remove-background', 'add-sunset')"),
    width: zod_1.z
        .number()
        .min(100)
        .max(4096)
        .optional()
        .describe("Optional new width in pixels (resizes the image)"),
    height: zod_1.z
        .number()
        .min(100)
        .max(4096)
        .optional()
        .describe("Optional new height in pixels (resizes the image)"),
    format: zod_1.z
        .enum(["png", "jpg"])
        .optional()
        .describe("Optional output format (defaults to source format)"),
    outputPath: zod_1.z
        .string()
        .optional()
        .describe("Optional local file path to save the edited image"),
}, async ({ sourceUrl, sourcePath, project, uploadPrompt, editInstruction, width, height, format, outputPath, }) => {
    let resolvedSourceUrl = sourceUrl;
    let sourceQuery = "";
    // If no URL provided, upload local file first
    if (!resolvedSourceUrl) {
        if (!sourcePath) {
            throw new Error("Either sourceUrl or sourcePath must be provided.");
        }
        if (!project) {
            throw new Error("Project is required when uploading a local file.");
        }
        const fs = await import("fs/promises");
        const path = await import("path");
        const fileBuffer = await fs.readFile(sourcePath);
        const ext = path.extname(sourcePath).toLowerCase().replace(".", "");
        const allowedExtensions = ["png", "jpg", "jpeg", "webp", "gif"];
        if (!allowedExtensions.includes(ext)) {
            throw new Error(`Invalid file type "${ext}". Allowed types: ${allowedExtensions.join(", ")}`);
        }
        const finalExt = ext === "jpeg" ? "jpg" : ext;
        const defaultPrompt = path.basename(sourcePath, path.extname(sourcePath));
        const sanitizedPrompt = (uploadPrompt || defaultPrompt)
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "");
        if (!sanitizedPrompt) {
            throw new Error("Upload prompt is required and cannot be empty.");
        }
        // Use form-data library for Node.js compatibility
        // Dynamic import to handle CommonJS module in ES module context
        const formDataModule = await import("form-data");
        const FormDataClass = formDataModule.default || formDataModule;
        const formData = new FormDataClass();
        // Append file buffer with proper options for form-data
        formData.append("file", fileBuffer, {
            filename: path.basename(sourcePath),
            contentType: `image/${finalExt}`,
        });
        formData.append("project", project);
        formData.append("prompt", sanitizedPrompt);
        // Get headers from form-data (includes Content-Type with boundary)
        const formHeaders = formData.getHeaders();
        // Convert form-data stream to buffer for fetch compatibility
        // Use PassThrough stream to ensure form-data flows properly
        const { PassThrough } = await import("stream");
        const passThrough = new PassThrough();
        const chunks = [];
        // Collect chunks from passThrough
        passThrough.on('data', (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        // Pipe form-data to passThrough to start the stream flowing
        formData.pipe(passThrough);
        // Wait for stream to end
        const formBuffer = await new Promise((resolve, reject) => {
            passThrough.on('end', () => {
                resolve(Buffer.concat(chunks));
            });
            passThrough.on('error', reject);
            formData.on('error', reject);
        });
        const uploadRes = await fetch(`${API_BASE}/content/upload`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                ...formHeaders,
            },
            // @ts-ignore - Buffer works with fetch in Node.js 18+
            body: formBuffer,
        });
        if (!uploadRes.ok) {
            const body = await uploadRes.text();
            throw new Error(`Upload failed ${uploadRes.status}: ${body}`);
        }
        const uploadData = await uploadRes.json();
        if (!uploadData?.success) {
            throw new Error(`Upload failed: ${uploadData?.message || "Unknown error"}`);
        }
        // The API returns content.prompt which is the full path (project/prompt.ext)
        const uploadedPrompt = uploadData?.content?.prompt;
        if (!uploadedPrompt) {
            throw new Error(`Upload succeeded but no prompt returned in response`);
        }
        resolvedSourceUrl = `${IMG_BASE}/${uploadedPrompt}`;
    }
    // Extract path and query from source URL
    let sourceUrlObj;
    try {
        sourceUrlObj = new URL(resolvedSourceUrl);
    }
    catch {
        throw new Error(`Invalid Inliner image URL: ${resolvedSourceUrl}`);
    }
    if (!sourceUrlObj.hostname.endsWith("img.inliner.ai")) {
        throw new Error(`Invalid Inliner image URL: ${resolvedSourceUrl}`);
    }
    const sourcePathFromUrl = sourceUrlObj.pathname.replace(/^\//, "");
    sourceQuery = sourceUrlObj.search || "";
    const sourcePathParts = sourcePathFromUrl.split("/");
    // Extract original dimensions and format from source path
    const sourceFileName = sourcePathParts[sourcePathParts.length - 1];
    const sourceMatch = sourceFileName.match(/^(.+)_(\d+)x(\d+)\.(png|jpg)$/);
    let baseDescription;
    let sourceWidth;
    let sourceHeight;
    let sourceFormat;
    if (sourceMatch) {
        // Image has dimensions in filename (generated image)
        const [, desc, w, h, fmt] = sourceMatch;
        baseDescription = desc;
        sourceWidth = parseInt(w, 10);
        sourceHeight = parseInt(h, 10);
        sourceFormat = fmt;
    }
    else {
        // Image doesn't have dimensions (uploaded image) - extract from actual file
        const formatMatch = sourceFileName.match(/^(.+)\.(png|jpg|jpeg|webp|gif)$/i);
        if (!formatMatch) {
            throw new Error(`Invalid source image path format: ${sourcePathFromUrl}`);
        }
        baseDescription = formatMatch[1];
        sourceFormat = formatMatch[2].toLowerCase() === 'jpeg' ? 'jpg' : formatMatch[2].toLowerCase();
        // For uploaded images, use the original file dimensions if we have sourcePath
        // Otherwise use default dimensions (the edit will handle resizing)
        if (sourcePath) {
            try {
                const fs = await import("fs/promises");
                const sharpModule = await import("sharp");
                const fileBuffer = await fs.readFile(sourcePath);
                const metadata = await sharpModule.default(fileBuffer).metadata();
                sourceWidth = metadata.width || 1024;
                sourceHeight = metadata.height || 1024;
            }
            catch {
                // Fallback if sharp fails
                sourceWidth = 1024;
                sourceHeight = 1024;
            }
        }
        else {
            // No sourcePath available, use defaults
            sourceWidth = 1024;
            sourceHeight = 1024;
        }
    }
    const outputFormat = format || sourceFormat;
    const outputWidth = width || sourceWidth;
    const outputHeight = height || sourceHeight;
    // Sanitize edit instruction
    let sanitizedEdit = editInstruction
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
    // If dimensions are specified, append them to the edit instruction so LLM can parse them
    // Format: edit-instruction-widthxheight (e.g., "make-it-blue-900x500")
    if (width || height) {
        sanitizedEdit += `-${outputWidth}x${outputHeight}`;
    }
    // Build edit URL to match CLI behavior:
    // /project/description_widthxheight.png/edit-instruction-widthxheight.png
    const editPath = `${sourcePathFromUrl}/${sanitizedEdit}.${outputFormat}`;
    const url = `${IMG_BASE}/${editPath}${sourceQuery}`;
    const pollUrl = `${API_BASE}/content/request-json/${editPath}${sourceQuery}`;
    // Poll until image is ready (max 3 minutes)
    const maxAttempts = 60;
    let attempt = 0;
    let imageBuffer = null;
    let status = "PENDING";
    while (attempt < maxAttempts) {
        try {
            const pollRes = await fetch(pollUrl, {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                },
            });
            if (pollRes.ok) {
                const pollData = await pollRes.json();
                // Check if image is ready - the API returns mediaAsset.data when complete
                if (pollData.mediaAsset && pollData.mediaAsset.data) {
                    // Extract base64 data from data URL
                    const dataUrl = pollData.mediaAsset.data;
                    if (dataUrl.startsWith("data:")) {
                        // Base64 data URL format: data:image/png;base64,<data>
                        const base64Data = dataUrl.split(",")[1];
                        imageBuffer = Buffer.from(base64Data, "base64");
                        break;
                    }
                    else {
                        // If it's a regular URL, fetch it
                        const imgRes = await fetch(dataUrl);
                        const arrayBuffer = await imgRes.arrayBuffer();
                        imageBuffer = Buffer.from(arrayBuffer);
                        break;
                    }
                }
                // Check for error status (though API may return 202 for pending)
                if (pollRes.status === 202) {
                    // 202 Accepted - still processing
                    status = "PENDING";
                }
                else if (pollRes.status >= 400) {
                    throw new Error(`API error ${pollRes.status}: ${JSON.stringify(pollData)}`);
                }
            }
            else if (pollRes.status === 202) {
                // 202 Accepted - still processing, continue polling
                status = "PENDING";
            }
            else {
                throw new Error(`API error ${pollRes.status}: ${await pollRes.text()}`);
            }
        }
        catch (err) {
            if (status === "FAILED") {
                throw err;
            }
            // Continue polling on transient errors
        }
        attempt++;
        await new Promise((resolve) => setTimeout(resolve, 3000)); // Wait 3 seconds
    }
    if (!imageBuffer) {
        throw new Error(`Image edit timeout after ${maxAttempts * 3} seconds. URL: ${url}`);
    }
    // Save to file if outputPath is provided
    if (outputPath) {
        const fs = await import("fs/promises");
        const path = await import("path");
        // Create directory if it doesn't exist
        const dir = path.dirname(outputPath);
        await fs.mkdir(dir, { recursive: true });
        // Write file
        await fs.writeFile(outputPath, imageBuffer);
    }
    const html = `<img src="${url}" alt="${editInstruction.replace(/-/g, " ")}" width="${outputWidth}" height="${outputHeight}" loading="lazy" />`;
    return toolResult({
        url,
        html,
        edited: true,
        saved: Boolean(outputPath),
        outputPath: outputPath || null,
        size: imageBuffer.byteLength,
        editInstruction,
        dimensions: `${outputWidth}x${outputHeight}`,
    });
});
server.tool("get_projects", "List all Inliner projects for the authenticated account, including namespaces and settings", {}, async () => {
    try {
        const data = await apiFetch("account/projects", apiKey);
        return toolResult(data);
    }
    catch (err) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error fetching projects: ${err.message}`,
                },
            ],
            isError: true,
        };
    }
});
server.tool("create_project", "Create and reserve a new project namespace. Call only when the user explicitly asks to create a project or approves creation after project resolution fails; do not create one as an implicit generation step.", {
    project: zod_1.z
        .string()
        .regex(/^[a-z0-9_-]+$/, "Project namespace must contain only lowercase letters, numbers, hyphens, and underscores")
        .describe("Project namespace (e.g. 'my-project', 'marketing', 'dev')"),
    displayName: zod_1.z
        .string()
        .describe("Display name for the project (e.g. 'My Project', 'Marketing Team')"),
    description: zod_1.z
        .string()
        .optional()
        .describe("Optional description for the project"),
    isDefault: zod_1.z
        .boolean()
        .default(false)
        .describe("Set this project as the default project for the account"),
}, async ({ project, displayName, description, isDefault }) => {
    try {
        const body = {
            project,
            displayName,
        };
        if (description)
            body.description = description;
        if (isDefault)
            body.isDefault = true;
        const url = `${API_BASE}/account/projects`;
        const res = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        // Check for API error response first (even if HTTP status is 200)
        if (!data.success) {
            throw new Error(data.message || "Failed to create project");
        }
        // Check for HTTP error status
        if (!res.ok) {
            const errorMsg = data.message || `HTTP ${res.status}`;
            throw new Error(errorMsg);
        }
        return toolResult({
            success: true,
            project: data.project,
            message: `Project '${project}' created successfully. Use this namespace with --project ${project} or in image URLs.`,
        });
    }
    catch (err) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error creating project: ${err.message}`,
                },
            ],
            isError: true,
        };
    }
});
server.tool("get_project_details", "Get detailed configuration for a specific project including namespace, custom prompt, and reference images", {
    projectId: zod_1.z.string().describe("Project ID from get_projects"),
}, async ({ projectId }) => {
    try {
        const data = await apiFetch(`account/projects/${projectId}`, apiKey);
        return toolResult(data);
    }
    catch (err) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error fetching project: ${err.message}`,
                },
            ],
            isError: true,
        };
    }
});
server.tool("get_usage", "Check remaining credits by type (base images, premium images, edits, infill, enhancement) for the current billing period", {}, async () => {
    try {
        const data = await apiFetch("account/plan-usage", apiKey);
        return toolResult(data);
    }
    catch (err) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error fetching usage: ${err.message}`,
                },
            ],
            isError: true,
        };
    }
});
server.tool("get_current_plan", "Get the current subscription plan and its feature allocations", {}, async () => {
    try {
        const data = await apiFetch("account/current-plan", apiKey);
        return toolResult(data);
    }
    catch (err) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error fetching plan: ${err.message}`,
                },
            ],
            isError: true,
        };
    }
});
server.tool("list_images", "List generated images in a project, with optional filtering", {
    projectId: zod_1.z
        .string()
        .optional()
        .describe("Filter by project ID (from get_projects)"),
    limit: zod_1.z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Number of images to return (1-100, default 20)"),
}, async ({ projectId, limit }) => {
    try {
        let path = `content/images?limit=${limit}`;
        if (projectId) {
            path += `&projectId=${projectId}`;
        }
        const data = await apiFetch(path, apiKey);
        return toolResult(data);
    }
    catch (err) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error fetching images: ${err.message}`,
                },
            ],
            isError: true,
        };
    }
});
server.tool("get_image_dimensions", "Get recommended image dimensions for common use cases", {
    useCase: zod_1.z
        .enum([
        "hero",
        "product",
        "profile",
        "card",
        "thumbnail",
        "social",
        "logo",
        "youtube",
        "banner",
    ])
        .describe("The intended use case for the image"),
}, async ({ useCase }) => {
    const dimensions = {
        hero: [
            { width: 1920, height: 1080, notes: "Full-width hero, 16:9" },
            { width: 1200, height: 600, notes: "Standard hero, 2:1" },
        ],
        product: [
            { width: 800, height: 800, notes: "Square product shot" },
            { width: 600, height: 400, notes: "Landscape product card" },
        ],
        profile: [
            { width: 400, height: 400, notes: "Standard avatar" },
            { width: 300, height: 300, notes: "Small avatar" },
        ],
        card: [
            { width: 600, height: 400, notes: "Feature card" },
            { width: 800, height: 600, notes: "Large card" },
        ],
        thumbnail: [
            { width: 200, height: 200, notes: "Grid thumbnail" },
            { width: 150, height: 150, notes: "Small thumbnail" },
        ],
        social: [
            { width: 1200, height: 630, notes: "Open Graph / Facebook" },
            { width: 1200, height: 675, notes: "Twitter card" },
        ],
        logo: [
            { width: 200, height: 200, notes: "Square logo, use .png" },
            { width: 100, height: 100, notes: "Small icon, use .png" },
        ],
        youtube: [
            { width: 1280, height: 720, notes: "YouTube thumbnail, 16:9" },
        ],
        banner: [
            { width: 1920, height: 400, notes: "Wide banner" },
            { width: 1200, height: 300, notes: "Standard banner" },
        ],
    };
    return toolResult({
        useCase,
        recommended: dimensions[useCase],
        format_hint: useCase === "logo"
            ? "Use .png for transparency support"
            : "Use .jpg for photos, .png for graphics/transparency",
    });
});
// --- Resources ---
server.resource("inliner-guide", "inliner://guide", async (uri) => ({
    contents: [
        {
            uri: uri.href,
            mimeType: "text/markdown",
            text: `# Inliner.ai Quick Reference

## Tool Selection
- New asset to insert or ship: call \`generate_image\` so the CDN URL is materialized.
- Change an identified existing asset: call \`edit_image\` with \`sourceUrl\` or \`sourcePath\`.
- URL or slug planning only: call \`recommend_image_url\`; it does not generate an image.
- Existing generated asset: reuse its CDN URL directly.
- Never call \`create_project\` without user intent.

## URL Format
\`https://img.inliner.ai/{project}/{description}_{WxH}.{png|jpg}\`

## Image Editing
Use \`edit_image\` with an explicit source rather than constructing edit URLs manually.

## Common Dimensions
- Hero: 1920x1080, 1200x600
- Product: 800x800, 600x400
- Profile: 400x400
- Card: 600x400
- Social: 1200x630
- Logo: 200x200 (use .png)

## Style Hints
Include in description: flat-illustration, 3d-render, watercolor, pixel-art, minimalist, photorealistic

## Tips
- Hyphenate descriptions: \`modern-office-team-meeting\`
- Keep under 100 characters
- Use .png for transparency, .jpg for photos
- Always include alt text and dimensions in HTML
- Account-owned URLs must be generated before insertion; a recommendation alone is not a completed asset.
`,
        },
    ],
}));
// --- Start ---
async function main() {
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
}
main().catch((err) => {
    console.error("Failed to start MCP server:", err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map
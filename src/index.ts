#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = process.env.INLINER_API_URL || "https://api.inliner.ai";
const IMG_BASE = "https://img.inliner.ai";

function getApiKey(): string {
  const key =
    process.env.INLINER_API_KEY ||
    process.argv.find((a) => a.startsWith("--api-key="))?.split("=")[1];
  if (!key) {
    console.error(
      "Error: INLINER_API_KEY environment variable or --api-key argument required"
    );
    process.exit(1);
  }
  return key;
}

async function apiFetch(path: string, apiKey: string, options?: RequestInit) {
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

// --- Server setup ---

const server = new McpServer({
  name: "inliner",
  version: "1.0.0",
});

const apiKey = getApiKey();

// --- Tools ---

server.tool(
  "generate_image_url",
  "Build a properly formatted Inliner.ai image URL from a description, dimensions, and project namespace",
  {
    project: z
      .string()
      .describe("Project namespace from Inliner dashboard (e.g. 'my-project')"),
    description: z
      .string()
      .describe(
        "Hyphenated image description (e.g. 'modern-office-team-meeting')"
      ),
    width: z
      .number()
      .min(100)
      .max(4096)
      .describe("Image width in pixels (100-4096)"),
    height: z
      .number()
      .min(100)
      .max(4096)
      .describe("Image height in pixels (100-4096)"),
    format: z
      .enum(["png", "jpg"])
      .default("png")
      .describe("Image format: png (transparency) or jpg (photos)"),
    edit: z
      .string()
      .optional()
      .describe(
        "Optional edit instruction to apply to an existing image (e.g. 'make-background-blue')"
      ),
  },
  async ({ project, description, width, height, format, edit }) => {
    const sanitized = description
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 100);

    let url = `${IMG_BASE}/${project}/${sanitized}_${width}x${height}`;
    if (edit) {
      const sanitizedEdit = edit
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-");
      url += `/${sanitizedEdit}`;
    }
    url += `.${format}`;

    const html = `<img src="${url}" alt="${description.replace(/-/g, " ")}" width="${width}" height="${height}" loading="lazy" />`;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ url, html }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "generate_image",
  "Generate an image and optionally save it to a local file. Polls until generation is complete (up to 3 minutes).",
  {
    project: z
      .string()
      .describe("Project namespace from Inliner dashboard (e.g. 'my-project')"),
    description: z
      .string()
      .describe(
        "Hyphenated image description (e.g. 'modern-office-team-meeting')"
      ),
    width: z
      .number()
      .min(100)
      .max(4096)
      .describe("Image width in pixels (100-4096)"),
    height: z
      .number()
      .min(100)
      .max(4096)
      .describe("Image height in pixels (100-4096)"),
    format: z
      .enum(["png", "jpg"])
      .default("png")
      .describe("Image format: png (transparency) or jpg (photos)"),
    outputPath: z
      .string()
      .optional()
      .describe("Optional local file path to save the image (e.g. './images/hero.png')"),
  },
  async ({ project, description, width, height, format, outputPath }) => {
    const sanitized = description
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 100);

    const url = `${IMG_BASE}/${project}/${sanitized}_${width}x${height}.${format}`;
    const pathPart = `${project}/${sanitized}_${width}x${height}.${format}`;
    const pollUrl = `${API_BASE}/content/request-json/${pathPart}`;

    // Poll until image is ready (max 3 minutes)
    const maxAttempts = 60;
    let attempt = 0;
    let imageBuffer: Buffer | null = null;
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
            } else {
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
          } else if (pollRes.status >= 400) {
            throw new Error(`API error ${pollRes.status}: ${JSON.stringify(pollData)}`);
          }
        } else if (pollRes.status === 202) {
          // 202 Accepted - still processing, continue polling
          status = "PENDING";
        } else {
          throw new Error(`API error ${pollRes.status}: ${await pollRes.text()}`);
        }
      } catch (err: any) {
        if (status === "FAILED") {
          throw err;
        }
        // Continue polling on transient errors
      }

      attempt++;
      await new Promise((resolve) => setTimeout(resolve, 3000)); // Wait 3 seconds
    }

    if (!imageBuffer) {
      throw new Error(`Image generation timeout after ${maxAttempts * 3} seconds. URL: ${url}`);
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

    const html = `<img src="${url}" alt="${description.replace(/-/g, " ")}" width="${width}" height="${height}" loading="lazy" />`;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              url,
              html,
              saved: outputPath ? true : false,
              outputPath: outputPath || null,
              size: imageBuffer.byteLength,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "create_image",
  "Quick alias for generating images with sensible defaults. Generates an 800x600 PNG image by default, polls until ready, and optionally saves to a local file.",
  {
    description: z
      .string()
      .describe("Image description (e.g., 'happy-duck', 'modern-office-hero')"),
    project: z
      .string()
      .optional()
      .describe("Project namespace (defaults to first available project if not specified)"),
    width: z
      .number()
      .min(100)
      .max(4096)
      .default(800)
      .optional()
      .describe("Image width in pixels (default: 800)"),
    height: z
      .number()
      .min(100)
      .max(4096)
      .default(600)
      .optional()
      .describe("Image height in pixels (default: 600)"),
    format: z
      .enum(["png", "jpg"])
      .default("png")
      .optional()
      .describe("Image format (default: png)"),
    outputPath: z
      .string()
      .optional()
      .describe("Optional local file path to save the image (e.g., './images/hero.png')"),
  },
  async ({ description, project, width = 800, height = 600, format = "png", outputPath }) => {
    // If no project specified, get the first available project
    let resolvedProject = project;
    if (!resolvedProject) {
      try {
        const projectsData = await apiFetch("account/projects", apiKey);
        if (projectsData?.projects && projectsData.projects.length > 0) {
          resolvedProject = projectsData.projects[0].project;
        } else {
          resolvedProject = "default";
        }
      } catch {
        resolvedProject = "default";
      }
    }

    // Use generate_image logic
    const sanitized = description
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 100);

    const url = `${IMG_BASE}/${resolvedProject}/${sanitized}_${width}x${height}.${format}`;
    const pathPart = `${resolvedProject}/${sanitized}_${width}x${height}.${format}`;
    const pollUrl = `${API_BASE}/content/request-json/${pathPart}`;

    // Poll until image is ready (max 3 minutes)
    const maxAttempts = 60;
    let attempt = 0;
    let imageBuffer: Buffer | null = null;
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
            } else {
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
          } else if (pollRes.status >= 400) {
            throw new Error(`API error ${pollRes.status}: ${JSON.stringify(pollData)}`);
          }
        } else if (pollRes.status === 202) {
          // 202 Accepted - still processing, continue polling
          status = "PENDING";
        } else {
          throw new Error(`API error ${pollRes.status}: ${await pollRes.text()}`);
        }
      } catch (err: any) {
        if (status === "FAILED") {
          throw err;
        }
        // Continue polling on transient errors
      }

      attempt++;
      await new Promise((resolve) => setTimeout(resolve, 3000)); // Wait 3 seconds
    }

    if (!imageBuffer) {
      throw new Error(`Image generation timeout after ${maxAttempts * 3} seconds. URL: ${url}`);
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

    const html = `<img src="${url}" alt="${description.replace(/-/g, " ")}" width="${width}" height="${height}" loading="lazy" />`;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              url,
              html,
              saved: outputPath ? true : false,
              outputPath: outputPath || null,
              size: imageBuffer.byteLength,
              project: resolvedProject,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "edit_image",
  "Edit an existing image by URL, apply edit instructions, optionally resize, and save to a local file. Polls until edit is complete (up to 3 minutes).",
  {
    sourceUrl: z
      .string()
      .optional()
      .describe("Source image URL (e.g., 'https://img.inliner.ai/project/image_800x800.png')"),
    sourcePath: z
      .string()
      .optional()
      .describe("Optional local file path to upload and edit (e.g., '/tmp/photo.png')"),
    project: z
      .string()
      .optional()
      .describe("Project namespace used when uploading a local file"),
    uploadPrompt: z
      .string()
      .optional()
      .describe("Optional prompt/filename for uploaded image (no slashes)"),
    editInstruction: z
      .string()
      .describe("Edit instruction (e.g., 'make-it-blue', 'remove-background', 'add-sunset')"),
    width: z
      .number()
      .min(100)
      .max(4096)
      .optional()
      .describe("Optional new width in pixels (resizes the image)"),
    height: z
      .number()
      .min(100)
      .max(4096)
      .optional()
      .describe("Optional new height in pixels (resizes the image)"),
    format: z
      .enum(["png", "jpg"])
      .optional()
      .describe("Optional output format (defaults to source format)"),
    outputPath: z
      .string()
      .optional()
      .describe("Optional local file path to save the edited image"),
  },
  async ({
    sourceUrl,
    sourcePath,
    project,
    uploadPrompt,
    editInstruction,
    width,
    height,
    format,
    outputPath,
  }) => {
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
      const FormDataClass = (formDataModule as any).default || formDataModule;
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
      const chunks: Buffer[] = [];
      
      // Collect chunks from passThrough
      passThrough.on('data', (chunk: Buffer) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      
      // Pipe form-data to passThrough to start the stream flowing
      formData.pipe(passThrough);
      
      // Wait for stream to end
      const formBuffer = await new Promise<Buffer>((resolve, reject) => {
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
    let sourceUrlObj: URL;
    try {
      sourceUrlObj = new URL(resolvedSourceUrl);
    } catch {
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
    
    let baseDescription: string;
    let sourceWidth: number;
    let sourceHeight: number;
    let sourceFormat: string;
    
    if (sourceMatch) {
      // Image has dimensions in filename (generated image)
      const [, desc, w, h, fmt] = sourceMatch;
      baseDescription = desc;
      sourceWidth = parseInt(w, 10);
      sourceHeight = parseInt(h, 10);
      sourceFormat = fmt;
    } else {
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
        } catch {
          // Fallback if sharp fails
          sourceWidth = 1024;
          sourceHeight = 1024;
        }
      } else {
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
    let imageBuffer: Buffer | null = null;
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
            } else {
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
          } else if (pollRes.status >= 400) {
            throw new Error(`API error ${pollRes.status}: ${JSON.stringify(pollData)}`);
          }
        } else if (pollRes.status === 202) {
          // 202 Accepted - still processing, continue polling
          status = "PENDING";
        } else {
          throw new Error(`API error ${pollRes.status}: ${await pollRes.text()}`);
        }
      } catch (err: any) {
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

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              url,
              html,
              saved: outputPath ? true : false,
              outputPath: outputPath || null,
              size: imageBuffer.byteLength,
              editInstruction,
              dimensions: `${outputWidth}x${outputHeight}`,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_projects",
  "List all Inliner projects for the authenticated account, including namespaces and settings",
  {},
  async () => {
    try {
      const data = await apiFetch("account/projects", apiKey);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error fetching projects: ${err.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "create_project",
  "Create a new project (reserves the namespace for your account). Use this to create a project namespace like 'my-project' that you can then use for generating images.",
  {
    project: z
      .string()
      .regex(/^[a-z0-9_-]+$/, "Project namespace must contain only lowercase letters, numbers, hyphens, and underscores")
      .describe("Project namespace (e.g. 'my-project', 'marketing', 'dev')"),
    displayName: z
      .string()
      .describe("Display name for the project (e.g. 'My Project', 'Marketing Team')"),
    description: z
      .string()
      .optional()
      .describe("Optional description for the project"),
    isDefault: z
      .boolean()
      .default(false)
      .describe("Set this project as the default project for the account"),
  },
  async ({ project, displayName, description, isDefault }) => {
    try {
      const body: any = {
        project,
        displayName,
      };
      if (description) body.description = description;
      if (isDefault) body.isDefault = true;

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

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              project: data.project,
              message: `Project '${project}' created successfully. Use this namespace with --project ${project} or in image URLs.`,
            }, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error creating project: ${err.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_project_details",
  "Get detailed configuration for a specific project including namespace, custom prompt, and reference images",
  {
    projectId: z.string().describe("Project ID from get_projects"),
  },
  async ({ projectId }) => {
    try {
      const data = await apiFetch(`account/projects/${projectId}`, apiKey);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error fetching project: ${err.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_usage",
  "Check remaining credits by type (base images, premium images, edits, infill, enhancement) for the current billing period",
  {},
  async () => {
    try {
      const data = await apiFetch("account/plan-usage", apiKey);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error fetching usage: ${err.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_current_plan",
  "Get the current subscription plan and its feature allocations",
  {},
  async () => {
    try {
      const data = await apiFetch("account/current-plan", apiKey);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error fetching plan: ${err.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "list_images",
  "List generated images in a project, with optional filtering",
  {
    projectId: z
      .string()
      .optional()
      .describe("Filter by project ID (from get_projects)"),
    limit: z
      .number()
      .min(1)
      .max(100)
      .default(20)
      .describe("Number of images to return (1-100, default 20)"),
  },
  async ({ projectId, limit }) => {
    try {
      let path = `content/images?limit=${limit}`;
      if (projectId) {
        path += `&projectId=${projectId}`;
      }
      const data = await apiFetch(path, apiKey);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error fetching images: ${err.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_image_dimensions",
  "Get recommended image dimensions for common use cases",
  {
    useCase: z
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
  },
  async ({ useCase }) => {
    const dimensions: Record<string, { width: number; height: number; notes: string }[]> = {
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

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              useCase,
              recommended: dimensions[useCase],
              format_hint:
                useCase === "logo"
                  ? "Use .png for transparency support"
                  : "Use .jpg for photos, .png for graphics/transparency",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// --- Resources ---

server.resource(
  "inliner-guide",
  "inliner://guide",
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "text/markdown",
        text: `# Inliner.ai Quick Reference

## URL Format
\`https://img.inliner.ai/{project}/{description}_{WxH}.{png|jpg}\`

## Image Editing
Append edit instructions: \`/{original-url}/{edit-instruction}.png\`

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
`,
      },
    ],
  })
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Failed to start MCP server:", err);
  process.exit(1);
});

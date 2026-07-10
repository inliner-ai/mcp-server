# @inliner/mcp-server

MCP server for [Inliner.ai](https://inliner.ai) — gives AI coding agents live access to your image projects, credits, and generation.

Works with any [Model Context Protocol](https://modelcontextprotocol.io) compatible tool: Claude Code, OpenAI Codex CLI, GitHub Copilot, Gemini CLI, Cursor, Windsurf, and more.

## Install

### Claude Code
```bash
claude mcp add --transport stdio inliner -- npx -y @inliner/mcp-server --api-key=YOUR_API_KEY

# Or with environment variable
export INLINER_API_KEY=your-key
claude mcp add --transport stdio inliner -- npx -y @inliner/mcp-server
```

### OpenAI Codex CLI
Use Codex's MCP command:
```bash
codex mcp add inliner --env INLINER_API_KEY=your-key -- npx -y @inliner/mcp-server
```

Then verify the server is configured:
```bash
codex mcp list
```

Or add it manually to `~/.codex/config.toml`:
```toml
[mcp_servers.inliner]
command = "npx"
args = ["-y", "@inliner/mcp-server"]

[mcp_servers.inliner.env]
INLINER_API_KEY = "your-key"
INLINER_DEFAULT_PROJECT = "your-project-namespace"
```

If you prefer to keep secrets in your shell environment, export them first and
forward them from Codex:
```toml
[mcp_servers.inliner]
command = "npx"
args = ["-y", "@inliner/mcp-server"]
env_vars = ["INLINER_API_KEY", "INLINER_DEFAULT_PROJECT"]
```

### Gemini CLI
Add to `~/.gemini/settings.json`:
```json
{
  "mcpServers": {
    "inliner": {
      "command": "npx",
      "args": ["-y", "@inliner/mcp-server"],
      "env": { "INLINER_API_KEY": "your-key" }
    }
  }
}
```

### VS Code / Cursor / Windsurf

**Project-specific (Recommended):**
Create `.cursor/mcp.json` (or `.vscode/mcp.json`) in your project root:
```json
{
  "mcpServers": {
    "inliner": {
      "command": "npx",
      "args": ["-y", "@inliner/mcp-server"],
      "env": {
        "INLINER_API_KEY": "your-key",
        "INLINER_DEFAULT_PROJECT": "your-project-namespace"
      }
    }
  }
}
```

**Global setup:**
Add to Cursor Settings > Features > MCP, or VS Code MCP settings:
```json
{
  "mcpServers": {
    "inliner": {
      "command": "npx",
      "args": ["-y", "@inliner/mcp-server"],
      "env": { "INLINER_API_KEY": "your-key" }
    }
  }
}
```

**Note:** Using the `env` field is recommended over `--api-key` command-line arguments for better compatibility with MCP clients.

Preferred project behavior:
- If a tool call omits `project`, the server resolves it in this order:
  1. `INLINER_DEFAULT_PROJECT` (if set)
  2. account default project
  3. first available project
  4. `"default"` fallback
- This reduces repetitive "which project?" confirmations in day-to-day usage.

## Agent behavior

The server publishes initialization instructions that tell compatible agents how to select tools:

- Use `generate_image` for a new asset that will be inserted, shipped, or verified. It generates the image before returning the account-owned CDN URL.
- Use `edit_image` when an existing source image is identified.
- Use `recommend_image_url` only for URL naming or planning. It does not generate an image.
- Reuse existing generated URLs directly.
- Never create a project unless the user requests or approves it.

Generation and editing consume the corresponding account credits. Read-only discovery and URL recommendation do not generate an asset.

## Tools

| Tool | Description |
|------|-------------|
| `generate_image` | Generate and host a new image with full prompt context and a concise smart slug; optionally save it locally |
| `edit_image` | Edit an existing image by URL **or** upload a local image, apply edit instructions, optionally resize, and save to a local file |
| `recommend_image_url` | Recommend a concise URL and HTML snippet without generating an image |
| `generate_image_url` | Deprecated compatibility alias for `recommend_image_url` |
| `create_image` | Deprecated compatibility alias for `generate_image` with 800x600 PNG defaults |
| `get_projects` | List all your Inliner projects with namespaces and settings |
| `create_project` | Create a new project (reserves namespace like 'my-project' for your account) |
| `get_project_details` | Get detailed project config: namespace, custom prompt, reference images |
| `get_usage` | Check remaining credits (base, premium, edit, infill, enhance) |
| `get_current_plan` | View current subscription plan and feature allocations |
| `list_images` | List generated images with optional project filter |
| `get_image_dimensions` | Get recommended dimensions for common use cases (hero, product, profile, etc.) |

## Resources

| Resource | URI | Description |
|----------|-----|-------------|
| Inliner Guide | `inliner://guide` | Quick reference for URL format, dimensions, and style hints |

## Example Interaction

Once installed, ask your AI agent naturally:

> "Create a project called 'marketing' for my marketing team"

The agent will use `create_project` to reserve the namespace, then you can use it for generating images.

> "Add a hero image to the landing page for my acme-corp project"

The agent will:
1. Call `get_project_details` to get your project config
2. Call `generate_image` with the right namespace and dimensions
3. Output the `<img>` tag with the correct URL, alt text, and loading attributes

Smart URL behavior:
- The server recommends concise slugs using `POST /url/recommend`
- Then generates with full prompt context using `POST /content/generate` and the selected slug
- This preserves rich prompt quality while producing readable/SEO-friendly URL paths
- `recommend_image_url` responses include the selected slug plus alternatives and explicitly report `generated: false`

> "Generate a happy duck image and save it to ./images/duck.png"

The agent will:
1. Call `generate_image` with the description, dimensions, and output path
2. Poll until the image is ready (up to 3 minutes)
3. Save the image to the specified file path
4. Return the URL and file path

> "Create a hero image for my landing page"

The agent will:
1. Choose dimensions from the layout and call `generate_image`
2. Poll until the hosted asset is ready
3. Return the URL and file path

> "Edit this local photo to remove the background and resize to 400x400"

The agent will:
1. Call `edit_image` with `sourcePath` pointing to the local file
2. Upload the file first (if no URL provided)
3. Apply the edit instruction
4. Resize to specified dimensions
5. Save the result

> "How many image credits do I have left?"

The agent calls `get_usage` and reports your remaining credits by type.

## API Key

Generate an API key from **Account > API Keys** in the [Inliner dashboard](https://app.inliner.ai/account). Only account owners can create and revoke keys.

Pass it via:
- **Environment variable** (recommended): `INLINER_API_KEY` — Use the `env` field in MCP configuration files
- **Command-line argument**: `--api-key=YOUR_KEY` — Works for standalone testing, but may have parsing issues with some MCP clients

## Links

- [Inliner.ai](https://inliner.ai)
- [Tutorials](https://inliner.ai/tutorial)
- [Model Context Protocol](https://modelcontextprotocol.io)

# MCP Servers Usage Guide

This rule file instructs the AI assistant on how to effectively use the available MCP servers.

## Available MCP Servers

### central-memory (Knowledge Graph)

**Purpose:** Persistent knowledge storage across sessions using a knowledge graph.

**When to use:**
- Store important findings, decisions, or context for future reference
- Track relationships between concepts, entities, or components
- Build up project knowledge over time

**Tools:**
- `create_entities` - Create new nodes in the knowledge graph
- `create_relations` - Link entities together with named relationships
- `add_observations` - Add facts/observations to existing entities
- `delete_entities` - Remove entities from the graph
- `read_graph` - Read the entire knowledge graph
- `search_nodes` - Search for entities by query
- `open_nodes` - Open specific entities by name

**Best practices:**
- Create entities for important concepts discovered during work
- Use relations to document how components interact
- Search the graph before asking the user for information they may have provided before

---

### central-filesystem (File Operations)

**Purpose:** Read and write files outside the current workspace.

**When to use:**
- Access files in other projects or directories
- Read configuration files from user's system
- Write output files to specific locations

**Tools:**
- `read_file` - Read contents of a file
- `read_multiple_files` - Read multiple files at once
- `write_file` - Write content to a file
- `edit_file` - Make targeted edits to a file
- `create_directory` - Create new directories
- `list_directory` - List directory contents
- `directory_tree` - Get recursive directory structure
- `move_file` - Move or rename files
- `search_files` - Search for files by pattern
- `get_file_info` - Get file metadata

---

### central-docsearch (Documentation Search)

**Purpose:** Hybrid semantic + keyword search across indexed documentation.

**When to use:**
- Search for API documentation, tutorials, or reference material
- Find information in indexed documentation sites
- ALWAYS check docsearch BEFORE doing web searches for topics that might be indexed

**Tools:**
- `doc-search` - Search indexed documents
  - `query` (required): Search query
  - `topK` (optional): Number of results (default: 8)
  - `source` (optional): Filter by source (`file`, `url`, `confluence`)
  - `mode` (optional): Search mode (`auto`, `vector`, `keyword`)
- `doc-ingest` - Manually trigger document ingestion
  - `source`: `file`, `url`, `confluence`, or `all`
  - `force`: Force re-crawl even if within lifetime
- `doc-ingest-status` - Get index statistics

**Resources:**
- `docchunk://{id}` - Retrieve full content of a specific chunk

**Best practices:**
- Use specific terms from the documentation for better results
- Avoid periods in version numbers (use "TypeScript 5 9" instead of "5.9")
- Use `mode: "keyword"` for exact phrase matching
- After finding results, use `docchunk://{id}` to get full context

**Query tips for better results:**
- If the user asks for the latest/newest info, set `latest: true`
- For broad topics, raise `topK` to 10-15
- Start with a specific query, then broaden if needed

---

### central-sequentialthinking (Reasoning)

**Purpose:** Dynamic, reflective problem-solving through structured thought sequences.

**When to use:**
- Complex multi-step problems requiring careful reasoning
- Debugging difficult issues
- Architecture decisions with multiple considerations

**Tools:**
- `sequentialthinking` - Process a thought in a sequence

---

### central-fake-qdrant (Vector Database)

**Purpose:** Local Qdrant-compatible vector database for similarity search.

**Tools:**
- `fake_qdrant_list_collections` - List all collections
- `fake_qdrant_create_collection` - Create a new collection
- `fake_qdrant_upsert_points` - Add/update vectors
- `fake_qdrant_query_points` - Search by vector similarity

---

## General Guidelines

1. **Check docsearch first:** Before searching the web, check if the topic might be indexed.

2. **Use memory for persistence:** Store important information in the knowledge graph.

3. **Prefer MCP tools over shell commands:** Use filesystem MCP for file operations.

4. **Combine tools effectively:** Use docsearch to find docs, memory to store findings.

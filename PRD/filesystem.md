# Product Requirements Document: Filesystem MCP Server

## Executive Summary

The Filesystem MCP Server provides secure file operations with configurable access controls for Large Language Models. It enables LLMs to read, write, create, list, search, and manipulate files and directories within explicitly allowed directory paths. The server implements strict path validation, supports dynamic directory access control via the MCP Roots protocol, and provides comprehensive file operation capabilities while maintaining security boundaries.

## Product Overview

### Purpose
Enable LLMs to interact with the local filesystem in a secure, controlled manner. The server provides file and directory operations while enforcing strict access controls to prevent unauthorized file system access.

### Target Users
- AI assistants requiring file system access for code editing, file management, and content analysis
- Developers building AI-powered development tools
- Users who need LLM assistance with file operations within specific directories

### Value Proposition
- Secure file operations with configurable access boundaries
- Comprehensive file and directory management capabilities
- Dynamic access control via MCP Roots protocol
- Support for both text and binary file operations
- Efficient batch operations for multiple files

## Goals and Objectives

### Primary Goals
1. Provide secure file system access for LLMs
2. Enforce strict directory access controls
3. Support dynamic access control via Roots protocol
4. Enable comprehensive file operations (read, write, create, delete, move)
5. Support both text and binary file handling

### Success Metrics
- All file operations respect allowed directory boundaries
- Path validation prevents directory traversal attacks
- Dynamic roots updates work without server restart
- File operations complete successfully within allowed directories
- Clear error messages for unauthorized access attempts

## Features and Capabilities

### Core Features
1. **File Reading** - Read text files, media files, and multiple files
2. **File Writing** - Write and edit text files
3. **Directory Operations** - Create, list, and navigate directories
4. **File Management** - Move, delete files and directories
5. **File Search** - Search for files by pattern with exclusion support
6. **Directory Tree** - Generate directory tree structures
7. **File Metadata** - Get file information (size, type, permissions)
8. **Path Validation** - Strict validation to prevent directory traversal
9. **Dynamic Roots** - Runtime directory access updates via Roots protocol
10. **Batch Operations** - Read multiple files efficiently

## Tools/API Reference

### Tools

#### `read_text_file`
- **Description**: Read the complete contents of a text file from the file system
- **Input Parameters**:
  - `path` (string, required): Path to the file (must be within allowed directories)
  - `head` (number, optional): Return only the first N lines
  - `tail` (number, optional): Return only the last N lines
- **Output**: File content as text
- **Constraints**: Cannot specify both `head` and `tail` simultaneously
- **Use Case**: Reading source code, configuration files, documentation

#### `read_file` (Deprecated)
- **Description**: Read file contents (deprecated, use `read_text_file`)
- **Status**: Deprecated but maintained for backward compatibility
- **Recommendation**: Use `read_text_file` instead

#### `read_media_file`
- **Description**: Read image or audio files, returns base64 encoded data and MIME type
- **Input Parameters**:
  - `path` (string, required): Path to the media file
- **Output**: Base64 encoded data with MIME type
- **Supported Formats**:
  - Images: PNG, JPEG, GIF, WebP, BMP, SVG
  - Audio: MP3, WAV, OGG, FLAC
- **Use Case**: Processing images and audio files

#### `read_multiple_files`
- **Description**: Read contents of multiple files simultaneously
- **Input Parameters**:
  - `paths` (array of strings, required): Array of file paths (minimum 1)
- **Output**: Object mapping file paths to their contents
- **Error Handling**: Failed reads for individual files don't stop the operation
- **Use Case**: Batch file reading for analysis or comparison

#### `write_file`
- **Description**: Write or overwrite a text file
- **Input Parameters**:
  - `path` (string, required): Path to the file
  - `content` (string, required): Content to write
- **Output**: Confirmation of write operation
- **Use Case**: Creating or updating text files, code files, configuration

#### `edit_file`
- **Description**: Apply text edits to a file using search-and-replace operations
- **Input Parameters**:
  - `path` (string, required): Path to the file
  - `edits` (array, required): Array of edit operations
    - Each edit: `oldText` (string), `newText` (string)
  - `dryRun` (boolean, optional): Preview changes using git-style diff (default: false)
- **Output**: 
  - If `dryRun=true`: Git-style diff showing changes
  - If `dryRun=false`: Confirmation of edits applied
- **Use Case**: Making precise edits to files, code modifications

#### `create_directory`
- **Description**: Create a new directory
- **Input Parameters**:
  - `path` (string, required): Path to the directory to create
- **Output**: Confirmation of directory creation
- **Use Case**: Creating project structure, organizing files

#### `list_directory`
- **Description**: List contents of a directory
- **Input Parameters**:
  - `path` (string, required): Path to the directory
- **Output**: List of files and subdirectories
- **Use Case**: Exploring directory structure, finding files

#### `list_directory_with_sizes`
- **Description**: List directory contents with file sizes
- **Input Parameters**:
  - `path` (string, required): Path to the directory
  - `sortBy` (string, optional): Sort by 'name' or 'size' (default: 'name')
- **Output**: List of files and directories with size information
- **Use Case**: Analyzing disk usage, finding large files

#### `directory_tree`
- **Description**: Generate a directory tree structure
- **Input Parameters**:
  - `path` (string, required): Root path for the tree
  - `excludePatterns` (array of strings, optional): Patterns to exclude (default: [])
- **Output**: Tree structure representation
- **Use Case**: Visualizing project structure, documentation

#### `move_file`
- **Description**: Move or rename a file or directory
- **Input Parameters**:
  - `source` (string, required): Source path
  - `destination` (string, required): Destination path
- **Output**: Confirmation of move operation
- **Use Case**: Reorganizing files, renaming files

#### `delete_file`
- **Description**: Delete a file or directory
- **Input Parameters**:
  - `path` (string, required): Path to the file or directory to delete
- **Output**: Confirmation of deletion
- **Use Case**: Cleaning up files, removing temporary files

#### `search_files`
- **Description**: Search for files matching a pattern
- **Input Parameters**:
  - `path` (string, required): Directory to search in
  - `pattern` (string, required): Search pattern (glob syntax)
  - `excludePatterns` (array of strings, optional): Patterns to exclude (default: [])
- **Output**: List of matching file paths
- **Use Case**: Finding files by name pattern, locating specific file types

#### `get_file_info`
- **Description**: Get metadata about a file or directory
- **Input Parameters**:
  - `path` (string, required): Path to the file or directory
- **Output**: File metadata (size, type, permissions, etc.)
- **Use Case**: Checking file properties, verifying file existence

## Use Cases and User Stories

### Use Case 1: Code Editing and Development
**As a** developer using an AI assistant  
**I want to** edit source code files  
**So that** I can make code changes efficiently

**Scenario**: Developer asks assistant to "add error handling to the login function". Assistant uses `read_text_file` to read the file, `edit_file` to make changes, and confirms the modifications.

### Use Case 2: Project Structure Analysis
**As a** developer  
**I want to** understand a project's structure  
**So that** I can navigate and work with the codebase

**Scenario**: Assistant uses `directory_tree` to generate project structure, `list_directory` to explore directories, and `search_files` to find specific file types.

### Use Case 3: Batch File Processing
**As an** AI assistant  
**I want to** read multiple files at once  
**So that** I can analyze related files efficiently

**Scenario**: Assistant uses `read_multiple_files` to read all configuration files in a project simultaneously for analysis.

### Use Case 4: File Organization
**As a** user  
**I want to** organize my files  
**So that** I can maintain a clean project structure

**Scenario**: Assistant uses `list_directory` to see current structure, `create_directory` to create new folders, and `move_file` to reorganize files.

### Use Case 5: Dynamic Access Control
**As a** developer  
**I want to** change allowed directories at runtime  
**So that** I can work with different projects without restarting

**Scenario**: Client uses MCP Roots protocol to update allowed directories dynamically, enabling the server to access new project directories without restart.

## Technical Requirements

### Implementation Details
- **Language**: TypeScript/Node.js
- **SDK**: @modelcontextprotocol/sdk
- **Validation**: Zod schemas for input validation
- **Path Handling**: Custom path utilities with normalization and validation
- **Security**: Strict path validation to prevent directory traversal

### Dependencies
- Node.js runtime
- @modelcontextprotocol/sdk
- Zod for schema validation
- minimatch for pattern matching
- fs/promises for async file operations

### Directory Access Control

#### Method 1: Command-Line Arguments
```bash
mcp-server-filesystem /path/to/dir1 /path/to/dir2
```
- Directories specified at server startup
- Must be absolute paths or use `~` for home directory
- All paths are normalized and resolved

#### Method 2: MCP Roots Protocol (Recommended)
- Client sends `roots/list_changed` notification
- Server updates allowed directories dynamically
- No server restart required
- Roots completely replace command-line directories when provided

#### Important Notes
- At least one directory must be provided by EITHER method
- If server starts without arguments AND client doesn't provide roots, server throws error
- Symlinks in allowed directories are resolved during startup
- Path validation ensures all operations stay within allowed boundaries

### Security Features
- **Path Validation**: All paths validated against allowed directories
- **Directory Traversal Prevention**: Strict validation prevents `../` attacks
- **Symlink Resolution**: Real paths resolved during startup
- **Normalized Paths**: All paths normalized for consistent comparison
- **Error Messages**: Clear errors for unauthorized access attempts

### Constraints
- All file operations restricted to allowed directories
- Path validation occurs for every operation
- No access to files outside allowed directories
- Symlinks are resolved to real paths
- Binary files handled via base64 encoding

## Configuration and Deployment

### Installation
```bash
npm install -g @modelcontextprotocol/server-filesystem
```

### Basic Usage
```bash
mcp-server-filesystem /path/to/allowed/directory
```

### Multiple Directories
```bash
mcp-server-filesystem /path/to/dir1 /path/to/dir2 /path/to/dir3
```

### Docker Deployment
```bash
docker run -i --rm -v /host/path:/container/path mcp/filesystem /container/path
```

### Configuration Examples

#### Claude Desktop
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/username/projects"
      ]
    }
  }
}
```

#### VS Code
```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "${workspaceFolder}"
      ]
    }
  }
}
```

#### With Dynamic Roots (Recommended)
```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem"
      ]
    }
  }
}
```
Then use client's roots protocol to set directories dynamically.

## Success Criteria

### Functional Requirements
- ✅ All file operations work within allowed directories
- ✅ Path validation prevents unauthorized access
- ✅ Dynamic roots updates work without restart
- ✅ Text and binary files handled correctly
- ✅ Batch operations work efficiently
- ✅ Directory operations function correctly
- ✅ File search with patterns works
- ✅ Error messages are clear and actionable

### Quality Requirements
- ✅ Comprehensive input validation using Zod
- ✅ Clear error messages for security violations
- ✅ Efficient file operations
- ✅ Proper handling of edge cases (symlinks, permissions)
- ✅ Backward compatibility with deprecated `read_file` tool

### Security Requirements
- ✅ No directory traversal attacks possible
- ✅ All paths validated before operations
- ✅ Symlinks resolved to real paths
- ✅ Clear boundaries between allowed and disallowed access
- ✅ No information leakage in error messages

## Out of Scope

### Explicitly Excluded
- File permissions modification (chmod)
- File ownership changes (chown)
- Symbolic link creation
- Hard link operations
- File system mounting/unmounting
- Network file system operations
- File locking mechanisms
- File watching/monitoring
- Compression/decompression operations
- File encryption/decryption

### Limitations
- Only works within explicitly allowed directories
- No recursive operations beyond directory tree generation
- No file watching or real-time updates
- No permission management
- No network file system support
- Binary files must be handled via base64 encoding

## Security Considerations

### Security Model
- **Whitelist Approach**: Only explicitly allowed directories are accessible
- **Path Validation**: Every operation validates paths against allowed directories
- **Symlink Resolution**: Symlinks resolved to prevent bypassing restrictions
- **Error Handling**: Security errors don't leak information about file system structure

### Best Practices
1. Start with minimal allowed directories
2. Use dynamic roots for flexible access control
3. Regularly review and audit allowed directories
4. Monitor file operations in production
5. Use read-only access when possible (via tool annotations)

### Risk Mitigation
- Strict path validation prevents directory traversal
- Allowed directories are resolved and normalized
- Clear error messages help identify configuration issues
- No automatic recursive operations beyond explicit tools

## Future Considerations

Potential enhancements not in current scope:
- File watching and change notifications
- File permissions management
- Symbolic link support
- File compression/decompression
- Advanced search with content matching
- File comparison and diff operations
- Backup and restore operations
- File encryption support
- Network file system support
- Performance optimizations for large directories


# Product Requirements Document: Git MCP Server

## Executive Summary

The Git MCP Server provides comprehensive Git repository interaction and automation capabilities for Large Language Models. It enables LLMs to read, search, and manipulate Git repositories through a standardized interface. The server supports common Git operations including status checking, diff viewing, commit creation, branch management, and commit history analysis with flexible filtering options.

## Product Overview

### Purpose
Enable LLMs to interact with Git repositories programmatically, allowing AI assistants to understand repository state, view changes, create commits, manage branches, and analyze commit history. This enables AI-powered development workflows and repository management.

### Target Users
- AI assistants helping with software development
- Developers building AI-powered Git tools
- Users who need LLM assistance with Git operations
- Automated development workflows

### Value Proposition
- Comprehensive Git operations through MCP interface
- Safe repository inspection and manipulation
- Flexible commit history filtering
- Branch management capabilities
- Integration with AI development workflows

## Goals and Objectives

### Primary Goals
1. Provide comprehensive Git repository access for LLMs
2. Enable safe repository operations (read, commit, branch management)
3. Support flexible commit history analysis
4. Enable AI-assisted development workflows
5. Support common Git operations needed for development

### Success Metrics
- All Git operations execute successfully
- Repository state is accurately represented
- Commit operations work correctly
- Branch management functions properly
- History filtering provides accurate results

## Features and Capabilities

### Core Features
1. **Repository Status** - View working tree and staging area status
2. **Diff Operations** - View unstaged, staged, and branch differences
3. **Commit Management** - Create commits with messages
4. **Staging Operations** - Add files to staging area
5. **Reset Operations** - Unstage changes
6. **Commit History** - View commit logs with flexible filtering
7. **Branch Management** - Create, list, and checkout branches
8. **Commit Inspection** - View commit contents and details
9. **Branch Filtering** - List branches with commit-based filtering

## Tools/API Reference

### Tools

#### `git_status`
- **Description**: Shows the working tree status
- **Input Parameters**:
  - `repo_path` (string, required): Path to Git repository
- **Output**: Current status of working directory as text output
- **Use Case**: Check repository state before operations, see what files have changed

#### `git_diff_unstaged`
- **Description**: Shows changes in working directory not yet staged
- **Input Parameters**:
  - `repo_path` (string, required): Path to Git repository
  - `context_lines` (number, optional): Number of context lines to show (default: 3)
- **Output**: Diff output of unstaged changes
- **Use Case**: Review uncommitted changes, see what modifications exist

#### `git_diff_staged`
- **Description**: Shows changes that are staged for commit
- **Input Parameters**:
  - `repo_path` (string, required): Path to Git repository
  - `context_lines` (number, optional): Number of context lines to show (default: 3)
- **Output**: Diff output of staged changes
- **Use Case**: Review what will be committed, verify staging area

#### `git_diff`
- **Description**: Shows differences between branches or commits
- **Input Parameters**:
  - `repo_path` (string, required): Path to Git repository
  - `target` (string, required): Target branch or commit to compare with
  - `context_lines` (number, optional): Number of context lines to show (default: 3)
- **Output**: Diff output comparing current state with target
- **Use Case**: Compare branches, see changes between commits

#### `git_commit`
- **Description**: Records changes to the repository
- **Input Parameters**:
  - `repo_path` (string, required): Path to Git repository
  - `message` (string, required): Commit message
- **Output**: Confirmation with new commit hash
- **Use Case**: Create commits with AI-generated messages

#### `git_add`
- **Description**: Adds file contents to the staging area
- **Input Parameters**:
  - `repo_path` (string, required): Path to Git repository
  - `files` (array of strings, required): Array of file paths to stage
- **Output**: Confirmation of staged files
- **Use Case**: Stage specific files for commit

#### `git_reset`
- **Description**: Unstages all staged changes
- **Input Parameters**:
  - `repo_path` (string, required): Path to Git repository
- **Output**: Confirmation of reset operation
- **Use Case**: Unstage all changes, start over with staging

#### `git_log`
- **Description**: Shows commit logs with optional date filtering
- **Input Parameters**:
  - `repo_path` (string, required): Path to Git repository
  - `max_count` (number, optional): Maximum number of commits to show (default: 10)
  - `start_timestamp` (string, optional): Start timestamp for filtering commits
    - Accepts ISO 8601 format (e.g., '2024-01-15T14:30:25')
    - Accepts relative dates (e.g., '2 weeks ago', 'yesterday')
    - Accepts absolute dates (e.g., '2024-01-15', 'Jan 15 2024')
  - `end_timestamp` (string, optional): End timestamp for filtering commits
    - Same format options as `start_timestamp`
- **Output**: Array of commit entries with hash, author, date, and message
- **Use Case**: Analyze commit history, find commits in date range

#### `git_create_branch`
- **Description**: Creates a new branch
- **Input Parameters**:
  - `repo_path` (string, required): Path to Git repository
  - `branch_name` (string, required): Name of the new branch
  - `base_branch` (string, optional): Base branch to create from (defaults to current branch)
- **Output**: Confirmation of branch creation
- **Use Case**: Create feature branches, branch from specific point

#### `git_checkout`
- **Description**: Switches branches
- **Input Parameters**:
  - `repo_path` (string, required): Path to Git repository
  - `branch_name` (string, required): Name of branch to checkout
- **Output**: Confirmation of branch switch
- **Use Case**: Switch between branches, checkout existing branches

#### `git_show`
- **Description**: Shows the contents of a commit
- **Input Parameters**:
  - `repo_path` (string, required): Path to Git repository
  - `revision` (string, required): The revision (commit hash, branch name, tag) to show
- **Output**: Contents of the specified commit
- **Use Case**: Inspect specific commits, view commit details

#### `git_branch`
- **Description**: List Git branches
- **Input Parameters**:
  - `repo_path` (string, required): Path to the Git repository
  - `branch_type` (string, required): Whether to list local branches ('local'), remote branches ('remote') or all branches ('all')
  - `contains` (string, optional): The commit sha that branch should contain
  - `not_contains` (string, optional): The commit sha that branch should NOT contain
- **Output**: List of branches matching criteria
- **Use Case**: Find branches containing specific commits, list branch structure

## Use Cases and User Stories

### Use Case 1: Code Review and Change Analysis
**As a** developer  
**I want to** review my uncommitted changes  
**So that** I can understand what I've modified

**Scenario**: Developer asks assistant to "show me what I've changed". Assistant uses `git_status` and `git_diff_unstaged` to show current modifications.

### Use Case 2: Commit Creation
**As a** developer  
**I want to** create commits with descriptive messages  
**So that** I can track my work properly

**Scenario**: Developer makes changes, asks assistant to "commit these changes with a message about fixing the login bug". Assistant uses `git_add`, `git_commit` to create the commit.

### Use Case 3: Branch Management
**As a** developer  
**I want to** create and switch branches  
**So that** I can work on features independently

**Scenario**: Developer asks to "create a new branch called feature-auth from main". Assistant uses `git_create_branch` with base_branch parameter.

### Use Case 4: History Analysis
**As a** developer  
**I want to** see commits from the last week  
**So that** I can track recent work

**Scenario**: Developer asks to "show commits from the last week". Assistant uses `git_log` with `start_timestamp='1 week ago'` to filter commits.

### Use Case 5: Branch Comparison
**As a** developer  
**I want to** see differences between branches  
**So that** I can understand what will be merged

**Scenario**: Developer asks to "show differences between feature-branch and main". Assistant uses `git_diff` with target parameter to compare branches.

### Use Case 6: Finding Branches
**As a** developer  
**I want to** find branches containing a specific commit  
**So that** I can understand branch relationships

**Scenario**: Developer asks "which branches contain commit abc123?". Assistant uses `git_branch` with `contains` parameter.

## Technical Requirements

### Implementation Details
- **Language**: Python
- **SDK**: mcp (Python MCP SDK)
- **Git Operations**: Uses GitPython library for Git operations
- **Date Parsing**: Flexible date parsing for timestamp filtering

### Dependencies
- Python 3.8+
- mcp Python SDK
- GitPython library
- Date parsing utilities

### Repository Configuration
- **Repository Path**: Can be specified via command-line argument `--repository`
- **Default Behavior**: Uses current working directory if not specified
- **Path Resolution**: Supports absolute and relative paths

### Constraints
- Requires Git to be installed on the system
- Repository must be a valid Git repository
- Operations are performed on the specified repository path
- Some operations require a clean working directory (e.g., checkout)
- Branch operations may fail if conflicts exist

### Security Considerations
- No authentication required (local repository access)
- Operations are limited to the specified repository
- No remote repository operations (push/pull) in current version
- File system access is limited to repository directory

## Configuration and Deployment

### Installation Methods

#### Using uv (Recommended)
```bash
uvx mcp-server-git --repository /path/to/repo
```

#### Using pip
```bash
pip install mcp-server-git
python -m mcp_server_git --repository /path/to/repo
```

#### Using Docker
```bash
docker run --rm -i --mount type=bind,src=/path/to/repo,dst=/workspace mcp/git
```

### Configuration Examples

#### Claude Desktop
```json
{
  "mcpServers": {
    "git": {
      "command": "uvx",
      "args": ["mcp-server-git", "--repository", "/path/to/git/repo"]
    }
  }
}
```

#### VS Code
```json
{
  "servers": {
    "git": {
      "command": "uvx",
      "args": ["mcp-server-git"]
    }
  }
}
```

#### Docker Configuration
```json
{
  "servers": {
    "git": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "--mount", "type=bind,src=${workspaceFolder},dst=/workspace",
        "mcp/git"
      ]
    }
  }
}
```

### Development Configuration
For local development:
```json
{
  "mcpServers": {
    "git": {
      "command": "uv",
      "args": [
        "--directory",
        "/path/to/mcp-servers/src/git",
        "run",
        "mcp-server-git"
      ]
    }
  }
}
```

## Success Criteria

### Functional Requirements
- ✅ All Git operations execute successfully
- ✅ Repository status accurately reflects current state
- ✅ Diff operations show correct changes
- ✅ Commits are created with proper messages
- ✅ Branch operations work correctly
- ✅ Commit history filtering works with various date formats
- ✅ Branch listing with commit filtering works
- ✅ Error handling provides clear messages

### Quality Requirements
- ✅ Input validation for all parameters
- ✅ Clear error messages for invalid operations
- ✅ Flexible date parsing for history filtering
- ✅ Proper handling of Git edge cases
- ✅ Efficient operations for large repositories

### Performance Requirements
- Operations complete in reasonable time
- History queries are efficient with filtering
- Branch operations don't block unnecessarily
- Diff operations handle large files appropriately

## Out of Scope

### Explicitly Excluded
- Remote repository operations (push, pull, fetch)
- Merge and rebase operations
- Tag management (create, delete, list tags)
- Stash operations
- Submodule management
- Git configuration management
- Authentication for remote repositories
- Conflict resolution
- Interactive rebase
- Cherry-pick operations
- Revert operations

### Limitations
- **Early Development**: Server is in early development, functionality subject to change
- **Local Only**: No remote repository operations
- **No Merge/Rebase**: Advanced Git operations not yet supported
- **Single Repository**: One repository per server instance
- **No Authentication**: Remote operations not supported

## Current Development Status

### Note
mcp-server-git is currently in **early development**. The functionality and available tools are subject to change and expansion as development continues.

### Planned Enhancements
- Remote repository operations (push, pull, fetch)
- Merge and rebase capabilities
- Tag management
- Stash operations
- Conflict resolution support
- More advanced filtering options

## Security Considerations

### Current Security Model
- Local repository access only
- No remote operations (reduces attack surface)
- Operations limited to specified repository path
- No authentication required (local access)

### Best Practices
1. Specify repository path explicitly
2. Use Docker mounts for containerized deployments
3. Review commit messages before creating commits
4. Verify branch operations before execution
5. Monitor Git operations in production environments

## Future Considerations

Potential enhancements for future versions:
- Remote repository operations (push, pull, fetch)
- Merge and rebase operations
- Tag creation and management
- Stash operations
- Submodule support
- Git configuration management
- Authentication for remote repositories
- Conflict resolution assistance
- Interactive operations
- Performance optimizations for large repositories
- Batch operations for efficiency


# Product Requirements Document: Memory MCP Server

## Executive Summary

The Memory MCP Server implements a persistent knowledge graph-based memory system that enables Large Language Models to remember information about users and entities across chat sessions. It uses a local knowledge graph structure with entities, relations, and observations to store and retrieve contextual information, enabling personalized AI interactions that maintain context over time.

## Product Overview

### Purpose
Enable LLMs to maintain persistent memory across conversations, storing information about users, entities, relationships, and facts in a structured knowledge graph. This allows AI assistants to provide personalized experiences and remember context from previous interactions.

### Target Users
- AI assistants requiring persistent memory capabilities
- Developers building personalized AI applications
- Users who want AI assistants to remember their preferences and information
- Applications requiring cross-session context retention

### Value Proposition
- Persistent memory across chat sessions
- Structured knowledge graph for complex relationships
- Efficient search and retrieval of stored information
- Flexible entity and relationship modeling
- Local storage for privacy and control

## Goals and Objectives

### Primary Goals
1. Provide persistent memory storage for LLMs
2. Enable structured knowledge representation via knowledge graph
3. Support efficient information retrieval and search
4. Maintain data persistence across sessions
5. Enable personalized AI interactions

### Success Metrics
- Information persists across chat sessions
- Knowledge graph accurately represents relationships
- Search and retrieval operations are efficient
- Memory operations complete successfully
- Data integrity maintained across operations

## Features and Capabilities

### Core Features
1. **Entity Management** - Create, read, update, and delete entities
2. **Relationship Management** - Create and manage relationships between entities
3. **Observation Storage** - Attach observations (facts) to entities
4. **Knowledge Graph Operations** - Read entire graph, search nodes, open specific nodes
5. **Persistent Storage** - JSONL format for durability
6. **Search Capabilities** - Search across names, types, and observations
7. **Graph Traversal** - Retrieve entities with their relationships

## Tools/API Reference

### Tools

#### `create_entities`
- **Description**: Create multiple new entities in the knowledge graph
- **Input Parameters**:
  - `entities` (array of objects, required): Array of entity objects
    - Each entity object contains:
      - `name` (string, required): Entity identifier (must be unique)
      - `entityType` (string, required): Type classification (e.g., "person", "organization", "event")
      - `observations` (array of strings, optional): Associated observations/facts
- **Output**: Confirmation of created entities
- **Behavior**: Ignores entities with existing names (idempotent)
- **Use Case**: Create new entities like people, organizations, or events

#### `create_relations`
- **Description**: Create multiple new relations between entities
- **Input Parameters**:
  - `relations` (array of objects, required): Array of relation objects
    - Each relation object contains:
      - `from` (string, required): Source entity name
      - `to` (string, required): Target entity name
      - `relationType` (string, required): Relationship type in active voice (e.g., "works_at", "knows", "attended")
- **Output**: Confirmation of created relations
- **Behavior**: Skips duplicate relations (idempotent)
- **Use Case**: Establish relationships between entities

#### `add_observations`
- **Description**: Add new observations to existing entities
- **Input Parameters**:
  - `observations` (array of objects, required): Array of observation objects
    - Each observation object contains:
      - `entityName` (string, required): Target entity name
      - `contents` (array of strings, required): New observations to add
- **Output**: Added observations per entity
- **Error Handling**: Fails if entity doesn't exist
- **Use Case**: Add new facts about existing entities

#### `delete_entities`
- **Description**: Remove entities and their relations
- **Input Parameters**:
  - `entityNames` (array of strings, required): Array of entity names to delete
- **Output**: Confirmation of deletion
- **Behavior**: 
  - Cascading deletion of associated relations
  - Silent operation if entity doesn't exist
- **Use Case**: Remove entities that are no longer relevant

#### `delete_observations`
- **Description**: Remove specific observations from entities
- **Input Parameters**:
  - `deletions` (array of objects, required): Array of deletion objects
    - Each deletion object contains:
      - `entityName` (string, required): Target entity name
      - `observations` (array of strings, required): Observations to remove
- **Output**: Confirmation of deletions
- **Behavior**: Silent operation if observation doesn't exist
- **Use Case**: Remove outdated or incorrect information

#### `delete_relations`
- **Description**: Remove specific relations from the graph
- **Input Parameters**:
  - `relations` (array of objects, required): Array of relation objects
    - Each relation object contains:
      - `from` (string, required): Source entity name
      - `to` (string, required): Target entity name
      - `relationType` (string, required): Relationship type
- **Output**: Confirmation of deletions
- **Behavior**: Silent operation if relation doesn't exist
- **Use Case**: Remove relationships that are no longer valid

#### `read_graph`
- **Description**: Read the entire knowledge graph
- **Input Parameters**: None
- **Output**: Complete graph structure with all entities and relations
- **Use Case**: Full graph export, backup, or analysis

#### `search_nodes`
- **Description**: Search for nodes based on query
- **Input Parameters**:
  - `query` (string, required): Search query string
- **Output**: Matching entities and their relations
- **Search Scope**: Searches across:
  - Entity names
  - Entity types
  - Observation content
- **Use Case**: Find entities by name, type, or associated information

#### `open_nodes`
- **Description**: Retrieve specific nodes by name
- **Input Parameters**:
  - `names` (array of strings, required): Array of entity names to retrieve
- **Output**: 
  - Requested entities with their observations
  - Relations between requested entities
- **Behavior**: Silently skips non-existent nodes
- **Use Case**: Retrieve specific entities and their relationships

## Use Cases and User Stories

### Use Case 1: Personal Information Memory
**As a** user  
**I want to** have my preferences remembered  
**So that** the AI assistant can provide personalized responses

**Scenario**: User mentions "I prefer morning meetings" and "I work at Acme Corp". Assistant creates entity for user, adds observations, creates relation to organization. In future sessions, assistant remembers these preferences.

### Use Case 2: Relationship Tracking
**As an** AI assistant  
**I want to** remember relationships between entities  
**So that** I can provide context-aware responses

**Scenario**: User mentions "My colleague John works at the same company". Assistant creates entities for user and John, creates "works_at" relation for both, and "colleague" relation between them.

### Use Case 3: Information Retrieval
**As a** user  
**I want to** ask about previously mentioned information  
**So that** I don't have to repeat myself

**Scenario**: User asks "What do you remember about me?". Assistant uses `read_graph` or `search_nodes` to retrieve stored information about the user.

### Use Case 4: Knowledge Graph Search
**As an** AI assistant  
**I want to** search for relevant entities  
**So that** I can provide informed responses

**Scenario**: User asks about "companies in San Francisco". Assistant uses `search_nodes` to find entities matching the query and retrieves related information.

### Use Case 5: Information Updates
**As a** user  
**I want to** update stored information  
**So that** my profile stays current

**Scenario**: User says "I've moved to a new company". Assistant uses `add_observations` to update entity information and `delete_relations`/`create_relations` to update relationships.

## Technical Requirements

### Implementation Details
- **Language**: TypeScript/Node.js
- **SDK**: @modelcontextprotocol/sdk
- **Storage Format**: JSONL (JSON Lines) - one JSON object per line
- **Storage Location**: Configurable via `MEMORY_FILE_PATH` environment variable
- **Default Location**: `memory.jsonl` in server directory

### Data Model

#### Entity Structure
```json
{
  "type": "entity",
  "name": "John_Smith",
  "entityType": "person",
  "observations": ["Speaks fluent Spanish", "Graduated in 2019"]
}
```

#### Relation Structure
```json
{
  "type": "relation",
  "from": "John_Smith",
  "to": "Anthropic",
  "relationType": "works_at"
}
```

### Storage Format
- **JSONL Format**: Each line is a separate JSON object
- **Entity Lines**: `{"type": "entity", "name": "...", "entityType": "...", "observations": [...]}`
- **Relation Lines**: `{"type": "relation", "from": "...", "to": "...", "relationType": "..."}`
- **Append-Only**: New entries appended to file
- **Backward Compatibility**: Automatically migrates from old `memory.json` format

### Dependencies
- Node.js runtime
- @modelcontextprotocol/sdk
- fs/promises for file operations

### Configuration Options
- `MEMORY_FILE_PATH`: Custom path to memory storage file (default: `memory.jsonl`)
- Supports absolute and relative paths
- Automatic migration from legacy `memory.json` format

### Constraints
- Entity names must be unique
- Relations require both source and target entities to exist
- Observations are atomic (one fact per observation string)
- File-based storage (no database)
- Single file for all memory data

## Configuration and Deployment

### Installation
```bash
npm install -g @modelcontextprotocol/server-memory
```

### Basic Usage
```bash
mcp-server-memory
```

### Docker Deployment
```bash
docker run -i -v claude-memory:/app/dist --rm mcp/memory
```

### Configuration Examples

#### Claude Desktop - NPX
```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-memory"
      ]
    }
  }
}
```

#### Claude Desktop - Docker
```json
{
  "mcpServers": {
    "memory": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "-v",
        "claude-memory:/app/dist",
        "--rm",
        "mcp/memory"
      ]
    }
  }
}
```

#### With Custom Memory File Path
```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-memory"
      ],
      "env": {
        "MEMORY_FILE_PATH": "/path/to/custom/memory.jsonl"
      }
    }
  }
}
```

### VS Code Configuration
```json
{
  "servers": {
    "memory": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-memory"
      ]
    }
  }
}
```

## Success Criteria

### Functional Requirements
- ✅ Entities can be created, read, updated, and deleted
- ✅ Relations can be created and deleted
- ✅ Observations can be added and removed
- ✅ Knowledge graph persists across sessions
- ✅ Search operations find relevant entities
- ✅ Graph operations maintain data integrity
- ✅ Cascading deletion works correctly
- ✅ Idempotent operations work as expected

### Quality Requirements
- ✅ Data persistence is reliable
- ✅ File operations are atomic where possible
- ✅ Error handling provides clear messages
- ✅ Backward compatibility with legacy format
- ✅ Efficient search and retrieval operations

### Performance Requirements
- Memory operations complete quickly (< 100ms for simple operations)
- Search operations are efficient for typical graph sizes
- File I/O doesn't block operations unnecessarily
- Graph loading is efficient on startup

## Out of Scope

### Explicitly Excluded
- Distributed storage or synchronization
- Multi-user access control
- Encryption at rest
- Backup and restore operations
- Graph visualization
- Advanced query language
- Relationship strength/weighting
- Temporal information (when facts were learned)
- Confidence scores for information
- Information source tracking
- Automatic fact verification
- Conflict resolution for contradictory information

### Limitations
- Single file storage (no database)
- No multi-user isolation
- No encryption by default
- No automatic backup
- No graph visualization tools
- Limited query capabilities (basic search only)
- No relationship weighting
- No temporal tracking

## Core Concepts

### Entities
Entities are the primary nodes in the knowledge graph. Each entity has:
- **Unique Name**: Identifier for the entity (e.g., "John_Smith")
- **Entity Type**: Classification (e.g., "person", "organization", "event")
- **Observations**: Array of discrete facts about the entity

**Example**:
```json
{
  "name": "John_Smith",
  "entityType": "person",
  "observations": ["Speaks fluent Spanish", "Graduated in 2019"]
}
```

### Relations
Relations define directed connections between entities. They are:
- **Directed**: From source entity to target entity
- **Active Voice**: Relation types use active voice (e.g., "works_at", not "worked_by")
- **Typed**: Each relation has a specific type

**Example**:
```json
{
  "from": "John_Smith",
  "to": "Anthropic",
  "relationType": "works_at"
}
```

### Observations
Observations are discrete pieces of information about entities:
- **Atomic**: One fact per observation string
- **Attached to Entities**: Observations belong to specific entities
- **Mutable**: Can be added or removed independently
- **String Format**: Stored as strings

**Example**:
```json
{
  "entityName": "John_Smith",
  "observations": [
    "Speaks fluent Spanish",
    "Graduated in 2019",
    "Prefers morning meetings"
  ]
}
```

## System Prompt Integration

### Recommended System Prompt
For chat personalization, use this prompt structure:

```
Follow these steps for each interaction:

1. User Identification:
   - Assume you are interacting with default_user
   - If you haven't identified default_user, proactively try to do so

2. Memory Retrieval:
   - Always begin your chat by saying only "Remembering..." and retrieve all relevant information from your knowledge graph
   - Always refer to your knowledge graph as your "memory"

3. Memory Categories:
   While conversing, be attentive to new information in these categories:
   a) Basic Identity (age, gender, location, job title, education level, etc.)
   b) Behaviors (interests, habits, etc.)
   c) Preferences (communication style, preferred language, etc.)
   d) Goals (goals, targets, aspirations, etc.)
   e) Relationships (personal and professional relationships up to 3 degrees of separation)

4. Memory Update:
   If new information was gathered, update your memory:
   a) Create entities for recurring organizations, people, and significant events
   b) Connect them using relations
   c) Store facts as observations
```

## Security and Privacy Considerations

### Privacy Model
- **Local Storage**: Memory stored locally, not in cloud
- **User Control**: Users control what information is stored
- **No External Sharing**: Memory data stays on local system
- **Explicit Storage**: Information only stored when explicitly processed

### Best Practices
1. Review what information is being stored
2. Use custom memory file paths for organization
3. Regularly review and clean up memory data
4. Consider privacy implications of stored information
5. Use Docker volumes for persistent storage in containers

### Data Management
- Memory file can be manually edited (JSONL format)
- Backup memory file regularly
- Delete memory file to reset all stored information
- Custom paths allow multiple memory stores

## Future Considerations

Potential enhancements not in current scope:
- Distributed storage and synchronization
- Multi-user access with isolation
- Encryption at rest
- Automatic backup and versioning
- Graph visualization tools
- Advanced query language
- Relationship weighting/scoring
- Temporal information tracking
- Confidence scores for facts
- Information source attribution
- Automatic fact verification
- Conflict resolution mechanisms
- Graph analytics and insights
- Export/import functionality
- Memory compression and optimization


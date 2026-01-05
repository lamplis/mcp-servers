# Product Requirements Document: Sequential Thinking MCP Server

## Executive Summary

The Sequential Thinking MCP Server provides a structured tool for dynamic and reflective problem-solving through a flexible thinking process. It enables Large Language Models to break down complex problems into manageable steps, revise previous thoughts, branch into alternative reasoning paths, and adjust the thinking process as understanding deepens. The tool supports hypothesis generation, verification, and iterative refinement until a satisfactory solution is reached.

## Product Overview

### Purpose
Enable LLMs to engage in structured, step-by-step reasoning processes that can adapt and evolve as understanding deepens. The tool facilitates complex problem-solving by allowing thoughts to be revised, branched, and extended dynamically, supporting both linear and non-linear reasoning patterns.

### Target Users
- AI assistants solving complex problems
- Developers building reasoning-based AI applications
- Users who need structured problem-solving assistance
- Applications requiring step-by-step analysis with revision capabilities

### Value Proposition
- Structured thinking process for complex problems
- Dynamic adjustment of reasoning as understanding evolves
- Support for revision and branching of thoughts
- Hypothesis generation and verification
- Flexible thought sequence management

## Goals and Objectives

### Primary Goals
1. Enable structured, step-by-step problem-solving
2. Support dynamic revision and refinement of thoughts
3. Allow branching into alternative reasoning paths
4. Facilitate hypothesis generation and verification
5. Provide flexible thought sequence management

### Success Metrics
- Complex problems are broken down into manageable steps
- Thoughts can be revised and refined effectively
- Alternative reasoning paths can be explored
- Hypotheses are generated and verified appropriately
- Solutions are reached through iterative refinement

## Features and Capabilities

### Core Features
1. **Sequential Thought Processing** - Step-by-step thinking with numbered thoughts
2. **Dynamic Thought Adjustment** - Modify total thoughts needed as understanding evolves
3. **Thought Revision** - Revise previous thoughts when new insights emerge
4. **Branching** - Explore alternative reasoning paths from any thought
5. **Hypothesis Generation** - Generate solution hypotheses during thinking
6. **Hypothesis Verification** - Verify hypotheses against Chain of Thought steps
7. **Iterative Refinement** - Repeat process until satisfactory solution reached
8. **Thought History Tracking** - Maintain complete history of thinking process

## Tools/API Reference

### Tools

#### `sequentialthinking`
- **Description**: A detailed tool for dynamic and reflective problem-solving through thoughts
- **Input Parameters**:
  - `thought` (string, required): The current thinking step
    - Can include: analytical steps, revisions, questions, realizations, approach changes, hypothesis generation, hypothesis verification
  - `nextThoughtNeeded` (boolean, required): Whether another thought step is needed
  - `thoughtNumber` (integer, required): Current thought number (minimum: 1)
  - `totalThoughts` (integer, required): Estimated total thoughts needed (minimum: 1)
    - Can be adjusted up or down as understanding evolves
  - `isRevision` (boolean, optional): Whether this thought revises previous thinking
  - `revisesThought` (integer, optional): Which thought number is being reconsidered (if `isRevision` is true)
  - `branchFromThought` (integer, optional): Branching point thought number (if branching)
  - `branchId` (string, optional): Identifier for the current branch (if branching)
  - `needsMoreThoughts` (boolean, optional): If reaching end but realizing more thoughts needed
- **Output**: 
  - `thoughtNumber`: Current thought number
  - `totalThoughts`: Updated total thoughts estimate
  - `nextThoughtNeeded`: Whether more thoughts are needed
  - `branches`: Array of branch identifiers
  - `thoughtHistoryLength`: Total number of thoughts in history
- **Use Case**: Complex problem-solving requiring structured reasoning

## Use Cases and User Stories

### Use Case 1: Complex Problem Analysis
**As an** AI assistant  
**I want to** break down complex problems into steps  
**So that** I can solve them systematically

**Scenario**: User asks "How should I design a distributed system?". Assistant uses sequential thinking to break down the problem into steps: requirements analysis, architecture design, component selection, etc., revising as understanding deepens.

### Use Case 2: Planning with Revision
**As a** developer  
**I want to** plan a project with room for revision  
**So that** I can adapt as I learn more

**Scenario**: Assistant plans a software project, but realizes mid-way that the initial approach needs revision. Uses `isRevision` and `revisesThought` to update earlier planning steps.

### Use Case 3: Exploring Alternatives
**As an** AI assistant  
**I want to** explore multiple solution approaches  
**So that** I can find the best solution

**Scenario**: Assistant considers multiple approaches to a problem. Uses branching (`branchFromThought`, `branchId`) to explore alternative paths, then compares them to select the best approach.

### Use Case 4: Hypothesis Testing
**As an** AI assistant  
**I want to** generate and verify hypotheses  
**So that** I can reach correct solutions

**Scenario**: Assistant generates a solution hypothesis, then verifies it against the Chain of Thought steps. If verification fails, revises the hypothesis and repeats until satisfied.

### Use Case 5: Adaptive Problem Solving
**As an** AI assistant  
**I want to** adjust my thinking as I learn  
**So that** I can handle problems where scope isn't clear initially

**Scenario**: Assistant starts with an estimate of 5 thoughts needed, but realizes the problem is more complex. Uses `needsMoreThoughts` and adjusts `totalThoughts` to 10, continuing the thinking process.

### Use Case 6: Filtering Irrelevant Information
**As an** AI assistant  
**I want to** focus on relevant information  
**So that** I can solve problems efficiently

**Scenario**: During thinking, assistant identifies irrelevant information and marks thoughts that should be ignored, maintaining focus on the core problem.

## Technical Requirements

### Implementation Details
- **Language**: TypeScript/Node.js
- **SDK**: @modelcontextprotocol/sdk
- **Architecture**: SequentialThinkingServer class manages thought history
- **Storage**: In-memory thought history per session
- **Validation**: Zod schemas for input/output validation

### Data Model

#### Thought Structure
- **Thought Number**: Sequential identifier
- **Thought Content**: Text content of the thought
- **Revision Flag**: Whether this revises a previous thought
- **Branch Information**: Branch identifier and source thought
- **Metadata**: Timestamps, relationships to other thoughts

#### Thought History
- Maintains complete history of all thoughts
- Tracks relationships (revisions, branches)
- Supports querying and retrieval
- Provides context for subsequent thoughts

### Dependencies
- Node.js runtime
- @modelcontextprotocol/sdk
- Zod for schema validation

### Configuration Options
- `DISABLE_THOUGHT_LOGGING`: Environment variable to disable thought logging (default: false)

### Constraints
- Thought numbers must be positive integers
- Total thoughts must be positive integer
- Revision references must point to existing thoughts
- Branch identifiers should be unique within a session
- Thought history is session-scoped (not persistent)

## Configuration and Deployment

### Installation
```bash
npm install -g @modelcontextprotocol/server-sequential-thinking
```

### Basic Usage
```bash
mcp-server-sequential-thinking
```

### Docker Deployment
```bash
docker run -i --rm mcp/sequentialthinking
```

### Configuration Examples

#### Claude Desktop - NPX
```json
{
  "mcpServers": {
    "sequential-thinking": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-sequential-thinking"
      ]
    }
  }
}
```

#### Claude Desktop - Docker
```json
{
  "mcpServers": {
    "sequentialthinking": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "mcp/sequentialthinking"
      ]
    }
  }
}
```

#### With Logging Disabled
```json
{
  "mcpServers": {
    "sequential-thinking": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-sequential-thinking"
      ],
      "env": {
        "DISABLE_THOUGHT_LOGGING": "true"
      }
    }
  }
}
```

### VS Code Configuration
```json
{
  "servers": {
    "sequential-thinking": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-sequential-thinking"
      ]
    }
  }
}
```

## Success Criteria

### Functional Requirements
- ✅ Thoughts are processed sequentially with proper numbering
- ✅ Total thoughts can be adjusted dynamically
- ✅ Previous thoughts can be revised
- ✅ Alternative paths can be explored via branching
- ✅ Hypotheses can be generated and verified
- ✅ Thought history is maintained accurately
- ✅ Output provides clear feedback on thinking state
- ✅ Branch information is tracked correctly

### Quality Requirements
- ✅ Input validation using Zod schemas
- ✅ Clear output structure with all required fields
- ✅ Thought history maintains relationships correctly
- ✅ Error handling for invalid operations
- ✅ Efficient thought processing

### Performance Requirements
- Thought processing completes quickly (< 50ms)
- Thought history management is efficient
- No memory leaks in long-running sessions
- Supports reasonable number of thoughts per session

## Usage Guidelines

### When to Use This Tool
- Breaking down complex problems into steps
- Planning and design with room for revision
- Analysis that might need course correction
- Problems where the full scope isn't clear initially
- Problems that require multi-step solutions
- Tasks that need to maintain context over multiple steps
- Situations where irrelevant information needs filtering

### Best Practices
1. **Start with Initial Estimate**: Begin with an estimate of needed thoughts, but be ready to adjust
2. **Feel Free to Revise**: Don't hesitate to question or revise previous thoughts
3. **Add More Thoughts When Needed**: Even at the "end", add more thoughts if needed
4. **Express Uncertainty**: Mark uncertainty when present
5. **Mark Revisions and Branches**: Clearly indicate when revising or branching
6. **Filter Irrelevant Information**: Ignore information irrelevant to current step
7. **Generate Hypotheses**: Generate solution hypotheses when appropriate
8. **Verify Hypotheses**: Verify hypotheses against Chain of Thought steps
9. **Repeat Until Satisfied**: Continue until a satisfactory solution is reached
10. **Provide Final Answer**: Only set `nextThoughtNeeded` to false when truly done

### Thought Process Flow
1. **Initial Analysis**: Start with first thought, estimate total thoughts
2. **Progressive Thinking**: Continue with numbered thoughts, building on previous
3. **Revision When Needed**: Revise previous thoughts if new insights emerge
4. **Branching for Alternatives**: Branch to explore alternative approaches
5. **Hypothesis Generation**: Generate solution hypothesis
6. **Verification**: Verify hypothesis against thinking steps
7. **Iteration**: Repeat verification until satisfied
8. **Finalization**: Set `nextThoughtNeeded` to false when solution is complete

## Out of Scope

### Explicitly Excluded
- Persistent storage of thought history
- Multi-user thought sharing
- Thought visualization or graphing
- Export/import of thought sequences
- Collaborative thinking sessions
- Thought templates or patterns
- Automatic thought generation
- Thought quality scoring
- Integration with external reasoning systems
- Real-time thought sharing

### Limitations
- **Session-Scoped**: Thought history is not persistent across sessions
- **In-Memory Only**: No persistent storage of thinking process
- **Single Session**: One thinking process per server session
- **No Visualization**: No built-in visualization of thought relationships
- **No Templates**: No pre-defined thinking patterns or templates

## Advanced Features

### Revision Mechanism
- **Purpose**: Allow correction of previous thinking
- **Usage**: Set `isRevision=true` and specify `revisesThought` number
- **Behavior**: Updates the thought history, maintaining relationships
- **Use Case**: When new information invalidates previous reasoning

### Branching Mechanism
- **Purpose**: Explore alternative reasoning paths
- **Usage**: Specify `branchFromThought` and `branchId`
- **Behavior**: Creates parallel thinking paths from a specific thought
- **Use Case**: When multiple approaches need to be explored

### Dynamic Adjustment
- **Purpose**: Adapt thinking scope as understanding evolves
- **Usage**: Modify `totalThoughts` and use `needsMoreThoughts` flag
- **Behavior**: Allows extension or reduction of thinking process
- **Use Case**: When initial estimate proves inaccurate

### Hypothesis Verification
- **Purpose**: Generate and verify solution hypotheses
- **Usage**: Include hypothesis in `thought` content, verify against steps
- **Behavior**: Supports iterative refinement until verification succeeds
- **Use Case**: When solution needs validation against reasoning steps

## Future Considerations

Potential enhancements not in current scope:
- Persistent storage of thought history
- Multi-user collaborative thinking
- Thought visualization and graphing tools
- Export/import functionality for thought sequences
- Thought templates and patterns library
- Automatic thought quality assessment
- Integration with external reasoning systems
- Real-time thought sharing and collaboration
- Thought analytics and insights
- Version control for thought sequences
- Thought search and retrieval
- Thought comparison and diff operations


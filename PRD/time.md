# Product Requirements Document: Time MCP Server

## Executive Summary

The Time MCP Server provides time and timezone conversion capabilities for Large Language Models. It enables LLMs to get current time information in specific timezones and perform accurate timezone conversions using IANA timezone names. The server includes automatic system timezone detection and supports both current time queries and time conversion operations.

## Product Overview

### Purpose
Enable LLMs to access accurate time information and perform timezone conversions, allowing AI assistants to provide time-aware responses and handle time-related queries across different timezones. This is essential for scheduling, time-sensitive operations, and providing context-aware time information.

### Target Users
- AI assistants requiring time-aware capabilities
- Developers building time-sensitive AI applications
- Users who need timezone conversion assistance
- Applications requiring accurate time information

### Value Proposition
- Accurate time information in any timezone
- Reliable timezone conversion using IANA standards
- Automatic system timezone detection
- Simple interface for time-related queries
- Support for daylight saving time (DST) transitions

## Goals and Objectives

### Primary Goals
1. Provide accurate current time in any timezone
2. Enable reliable timezone conversions
3. Support IANA timezone standard
4. Automatically detect system timezone
5. Handle daylight saving time correctly

### Success Metrics
- Time queries return accurate current time
- Timezone conversions are correct
- DST transitions are handled properly
- System timezone detection works correctly
- IANA timezone names are validated

## Features and Capabilities

### Core Features
1. **Current Time Queries** - Get current time in any IANA timezone
2. **Timezone Conversion** - Convert time between timezones
3. **System Timezone Detection** - Automatic detection of local timezone
4. **DST Support** - Correct handling of daylight saving time
5. **IANA Timezone Support** - Full support for IANA timezone database
6. **Time Difference Calculation** - Calculate time differences between timezones

## Tools/API Reference

### Tools

#### `get_current_time`
- **Description**: Get current time in a specific timezone or system timezone
- **Input Parameters**:
  - `timezone` (string, required): IANA timezone name (e.g., 'America/New_York', 'Europe/London', 'Asia/Tokyo')
- **Output**: 
  - `timezone`: The timezone used
  - `datetime`: ISO 8601 formatted datetime string with timezone offset
  - `is_dst`: Boolean indicating if daylight saving time is active
- **Use Case**: Get current time in a specific location, check what time it is now

**Example Request**:
```json
{
  "name": "get_current_time",
  "arguments": {
    "timezone": "Europe/Warsaw"
  }
}
```

**Example Response**:
```json
{
  "timezone": "Europe/Warsaw",
  "datetime": "2024-01-01T13:00:00+01:00",
  "is_dst": false
}
```

#### `convert_time`
- **Description**: Convert time between timezones
- **Input Parameters**:
  - `source_timezone` (string, required): Source IANA timezone name
  - `time` (string, required): Time in 24-hour format (HH:MM)
  - `target_timezone` (string, required): Target IANA timezone name
- **Output**: 
  - `source`: Object with source timezone, datetime, and DST status
  - `target`: Object with target timezone, datetime, and DST status
  - `time_difference`: Time difference in hours (e.g., "+13.0h", "-5.0h")
- **Use Case**: Convert meeting times, schedule across timezones, understand time differences

**Example Request**:
```json
{
  "name": "convert_time",
  "arguments": {
    "source_timezone": "America/New_York",
    "time": "16:30",
    "target_timezone": "Asia/Tokyo"
  }
}
```

**Example Response**:
```json
{
  "source": {
    "timezone": "America/New_York",
    "datetime": "2024-01-01T12:30:00-05:00",
    "is_dst": false
  },
  "target": {
    "timezone": "Asia/Tokyo",
    "datetime": "2024-01-01T12:30:00+09:00",
    "is_dst": false
  },
  "time_difference": "+13.0h"
}
```

## Use Cases and User Stories

### Use Case 1: Current Time Queries
**As a** user  
**I want to** know what time it is in different locations  
**So that** I can coordinate with people in other timezones

**Scenario**: User asks "What time is it in Tokyo?". Assistant uses `get_current_time` with timezone "Asia/Tokyo" to provide current time.

### Use Case 2: Meeting Scheduling
**As a** user  
**I want to** schedule meetings across timezones  
**So that** I can find times that work for everyone

**Scenario**: User asks "If it's 4 PM in New York, what time is it in London?". Assistant uses `convert_time` to convert between America/New_York and Europe/London.

### Use Case 3: Time Difference Understanding
**As a** user  
**I want to** understand time differences between locations  
**So that** I can plan communications appropriately

**Scenario**: User asks "What's the time difference between New York and Tokyo?". Assistant uses `convert_time` to get the time difference information.

### Use Case 4: DST Awareness
**As a** user  
**I want to** know if a location is in daylight saving time  
**So that** I can account for DST changes

**Scenario**: User asks "Is New York currently in daylight saving time?". Assistant uses `get_current_time` and checks the `is_dst` field in the response.

### Use Case 5: System Timezone
**As a** user  
**I want to** know the current time in my system timezone  
**So that** I can get local time information

**Scenario**: User asks "What time is it now?". Assistant uses `get_current_time` with system-detected timezone to provide local time.

## Technical Requirements

### Implementation Details
- **Language**: Python
- **SDK**: mcp (Python MCP SDK)
- **Timezone Library**: Uses Python's `zoneinfo` or `pytz` for timezone handling
- **Time Format**: ISO 8601 format for datetime strings
- **IANA Database**: Uses IANA Time Zone Database

### Dependencies
- Python 3.8+
- mcp Python SDK
- Timezone library (zoneinfo or pytz)
- Date/time parsing utilities

### Configuration Options
- `--local-timezone`: Override system timezone detection with custom IANA timezone
- System timezone detection is automatic if not specified

### Timezone Format
- **IANA Timezone Names**: Uses standard IANA timezone identifiers
- **Examples**: 
  - `America/New_York`
  - `Europe/London`
  - `Asia/Tokyo`
  - `Australia/Sydney`
- **Validation**: Invalid timezone names result in error

### Constraints
- Time input format: 24-hour format (HH:MM)
- Timezone names must be valid IANA identifiers
- Date is assumed to be today for time conversion
- DST transitions are handled automatically
- System timezone detection may vary by platform

### Security Considerations
- No external network access required
- Uses system timezone database
- No user data storage
- Read-only time operations

## Configuration and Deployment

### Installation Methods

#### Using uv (Recommended)
```bash
uvx mcp-server-time
```

#### Using pip
```bash
pip install mcp-server-time
python -m mcp_server_time
```

#### Using Docker
```bash
docker run -i --rm -e LOCAL_TIMEZONE mcp/time
```

### Configuration Examples

#### Claude Desktop - Basic
```json
{
  "mcpServers": {
    "time": {
      "command": "uvx",
      "args": ["mcp-server-time"]
    }
  }
}
```

#### Claude Desktop - With Custom Timezone
```json
{
  "mcpServers": {
    "time": {
      "command": "uvx",
      "args": ["mcp-server-time", "--local-timezone=America/New_York"]
    }
  }
}
```

#### Claude Desktop - Docker
```json
{
  "mcpServers": {
    "time": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "LOCAL_TIMEZONE", "mcp/time"]
    }
  }
}
```

#### VS Code Configuration
```json
{
  "mcp": {
    "servers": {
      "time": {
        "command": "uvx",
        "args": ["mcp-server-time"]
      }
    }
  }
}
```

#### With Custom Local Timezone
```json
{
  "mcp": {
    "servers": {
      "time": {
        "command": "python",
        "args": ["-m", "mcp_server_time", "--local-timezone=America/New_York"]
      }
    }
  }
}
```

### Customization Options

#### System Timezone Override
By default, the server automatically detects your system's timezone. You can override this:
```json
{
  "command": "python",
  "args": ["-m", "mcp_server_time", "--local-timezone=America/New_York"]
}
```

## Success Criteria

### Functional Requirements
- ✅ Current time queries return accurate time
- ✅ Timezone conversions are mathematically correct
- ✅ DST transitions are handled properly
- ✅ System timezone detection works correctly
- ✅ IANA timezone names are validated
- ✅ Time differences are calculated accurately
- ✅ ISO 8601 format is used consistently
- ✅ Error handling for invalid timezones

### Quality Requirements
- ✅ Input validation for timezone names
- ✅ Clear error messages for invalid inputs
- ✅ Accurate time calculations
- ✅ Proper DST handling
- ✅ Consistent datetime formatting

### Performance Requirements
- Time queries complete quickly (< 50ms)
- Timezone conversions are efficient
- No external dependencies or network calls
- Low memory footprint

## Out of Scope

### Explicitly Excluded
- Calendar operations (date arithmetic, date ranges)
- Recurring event scheduling
- Time zone database updates
- Historical timezone information
- Time zone offset calculations for past dates
- Time formatting customization
- Time zone abbreviation support
- World clock displays
- Alarm or reminder functionality
- Time-based automation triggers

### Limitations
- **Current Date Only**: Time conversion assumes today's date
- **No Calendar Operations**: No date arithmetic or calendar functions
- **No Historical Data**: Cannot query past timezone information
- **No Recurring Events**: No support for recurring schedules
- **IANA Only**: Only supports IANA timezone names, not abbreviations

## Example Interactions

### Example 1: Current Time Query
**User**: "What time is it now?"  
**Assistant**: Uses `get_current_time` with system timezone  
**Response**: Current time in user's timezone

### Example 2: Specific Timezone Query
**User**: "What time is it in Tokyo?"  
**Assistant**: Uses `get_current_time` with timezone "Asia/Tokyo"  
**Response**: Current time in Tokyo with DST status

### Example 3: Time Conversion
**User**: "When it's 4 PM in New York, what time is it in London?"  
**Assistant**: Uses `convert_time` with source "America/New_York", time "16:00", target "Europe/London"  
**Response**: Converted time with time difference

### Example 4: Time Difference
**User**: "Convert 9:30 AM Tokyo time to New York time"  
**Assistant**: Uses `convert_time` with source "Asia/Tokyo", time "09:30", target "America/New_York"  
**Response**: Converted time showing both timezones and difference

## IANA Timezone Database

### Supported Timezones
The server supports all timezones in the IANA Time Zone Database, including:

- **Americas**: America/New_York, America/Chicago, America/Denver, America/Los_Angeles, America/Sao_Paulo, etc.
- **Europe**: Europe/London, Europe/Paris, Europe/Berlin, Europe/Moscow, etc.
- **Asia**: Asia/Tokyo, Asia/Shanghai, Asia/Dubai, Asia/Kolkata, etc.
- **Oceania**: Australia/Sydney, Australia/Melbourne, Pacific/Auckland, etc.
- **Africa**: Africa/Cairo, Africa/Johannesburg, etc.

### Timezone Format
- Use full IANA timezone names (e.g., `America/New_York`)
- Do not use abbreviations (e.g., `EST`, `PST`) - these are ambiguous
- Case-sensitive: `America/New_York` is correct, `america/new_york` may fail

## Daylight Saving Time (DST)

### Automatic Handling
- DST transitions are handled automatically
- `is_dst` field indicates if DST is currently active
- Time conversions account for DST in both source and target timezones
- DST rules are based on IANA timezone database

### DST Examples
- **Summer in New York**: `is_dst: true` (EDT - Eastern Daylight Time)
- **Winter in New York**: `is_dst: false` (EST - Eastern Standard Time)
- **London (GMT/BST)**: `is_dst: true` in summer (BST), `is_dst: false` in winter (GMT)

## Security and Privacy Considerations

### Privacy Model
- **No Data Storage**: No user data or queries are stored
- **No Network Access**: All operations are local
- **No Tracking**: No usage tracking or analytics
- **Read-Only Operations**: Only time queries, no data modification

### Security Features
- Input validation prevents injection attacks
- Timezone name validation prevents invalid inputs
- No external network dependencies
- Local-only operations

## Future Considerations

Potential enhancements not in current scope:
- Calendar operations and date arithmetic
- Recurring event scheduling
- Historical timezone information queries
- Time zone database update mechanisms
- Time formatting customization options
- Time zone abbreviation support
- World clock displays
- Alarm and reminder functionality
- Time-based automation triggers
- Date range operations
- Time zone offset calculations for past dates
- Integration with calendar systems
- Time zone change notifications


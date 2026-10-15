# Active Directory User Export

This example shows a complete integration to retrieve user information from an
on-premise Active Directory via the FLAMOX365 Cloud.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           FLAMOX365 Cloud                                  │
│                                                                              │
│   Workflow: "Get all IT employees"                                           │
│        │                                                                     │
│        │  GET /ad/users?department=IT                                        │
│        ▼                                                                     │
│   ┌─────────────┐                                                            │
│   │   Gateway   │◄──── WebSocket (outbound) ────┐                            │
│   └─────────────┘                               │                            │
└─────────────────────────────────────────────────│────────────────────────────┘
                                                  │
┌─────────────────────────────────────────────────│────────────────────────────┐
│                      Customer Network (DMZ)     │                            │
│                                                 ▼                            │
│   ┌───────────────────────────────────────────────────────────────────────┐  │
│   │                       Edge Connector                                 │  │
│   │                                                                       │  │
│   │   request.ts:                                                         │  │
│   │   - Add authentication                                                │  │
│   │   - Transform URL: /ad/users → /api/users                             │  │
│   │                                                                       │  │
│   │   response.ts:                                                        │  │
│   │   - Remove sensitive fields (objectGUID, etc.)                        │  │
│   │   - Normalize fields                                                  │  │
│   └───────────────────────────────────────────────────────────────────────┘  │
│                                    │                                         │
│                                    │  GET /api/users?filter=(department=IT)  │
│                                    ▼                                         │
│   ┌───────────────────────────────────────────────────────────────────────┐  │
│   │                       AD Bridge API (Python)                          │  │
│   │                                                                       │  │
│   │   - REST endpoints for Users/Groups                                   │  │
│   │   - LDAP connection to Domain Controller                              │  │
│   │   - Authentication with Service Account                               │  │
│   └───────────────────────────────────────────────────────────────────────┘  │
│                                    │                                         │
│                                    │  LDAP (389/636)                         │
│                                    ▼                                         │
│   ┌───────────────────────────────────────────────────────────────────────┐  │
│   │                      Active Directory                                 │  │
│   │                      (Domain Controller)                              │  │
│   └───────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Edge Connector Functions (`functions/`)

TypeScript-based API endpoints that process requests and forward them to the
bridge.

| File                                  | Endpoint                     | Description       |
| ------------------------------------- | ---------------------------- | ----------------- |
| `functions/health.ts`                 | `GET /health`                | Health check      |
| `functions/ad/users/index.ts`         | `GET /ad/users`              | Get all users     |
| `functions/ad/users/[id].ts`          | `GET /ad/users/:id`          | Get single user   |
| `functions/ad/groups/index.ts`        | `GET /ad/groups`             | Get all groups    |
| `functions/ad/groups/[id]/members.ts` | `GET /ad/groups/:id/members` | Get group members |

### 2. AD Bridge API (`bridge/`)

A Python-based REST API that executes LDAP queries against Active Directory.

**Endpoints:**

| Method | Path                          | Description       |
| ------ | ----------------------------- | ----------------- |
| GET    | `/api/v1/users`               | Get all users     |
| GET    | `/api/v1/users/{samname}`     | Get single user   |
| GET    | `/api/v1/groups`              | Get all groups    |
| GET    | `/api/v1/groups/{cn}/members` | Get group members |

**Query Parameters:**

- `filter` – LDAP filter (e.g., `(department=IT)`)
- `limit` – Maximum number of results

### 3. Docker Compose

Starts all components together.

## Project Structure

```
ad-user-export/
├── package.json
├── docker-compose.yml
├── .env.example
├── functions/
│   ├── health.ts
│   └── ad/
│       ├── users/
│       │   ├── index.ts      # GET /ad/users
│       │   └── [id].ts       # GET /ad/users/:id
│       └── groups/
│           ├── index.ts      # GET /ad/groups
│           └── [id]/
│               └── members.ts # GET /ad/groups/:id/members
└── bridge/
    ├── Dockerfile
    ├── requirements.txt
    └── app/
        └── ...
```

## Quick Start

### 1. Prerequisites

- Docker and Docker Compose
- Network access to Domain Controller (Port 389 or 636)
- Service account with read permissions on AD

### 2. Configuration

```bash
cp .env.example .env
nano .env
```

Required variables:

```env
# FLAMOX365 Cloud
FLAMOX_WS_URL=wss://api.example.com/connector/ws?tenant=your-tenant

# Active Directory
AD_SERVER=ldap://dc01.corp.example.com
AD_BASE_DN=DC=corp,DC=example,DC=com
AD_BIND_USER=CN=svc_edge_connector,OU=Service Accounts,DC=corp,DC=example,DC=com
AD_BIND_PASSWORD=your-service-account-password

# Bridge API
BRIDGE_API_TOKEN=your-random-api-token
```

### 3. Start

```bash
docker-compose up -d
```

### 4. Test

```bash
# Health check
curl http://localhost:8080/health

# All users from IT department
curl http://localhost:8080/ad/users?department=IT

# Single user
curl http://localhost:8080/ad/users/mmueller

# All groups
curl http://localhost:8080/ad/groups

# Members of a group
curl http://localhost:8080/ad/groups/IT-Team/members
```

## API Reference

### List Users

**Request (FLAMOX365 Cloud):**

```
GET /ad/users?department=IT&limit=10
```

**Response:**

```json
{
  "users": [
    {
      "id": "mmueller",
    "displayName": "Max Mueller",
      "email": "m.mueller@example.com",
      "department": "IT",
    "title": "Software Engineer",
    "manager": "CN=Anna Schmidt,OU=Users,DC=corp,DC=example,DC=com",
    "memberOf": [
      "CN=IT-Team,OU=Groups,DC=corp,DC=example,DC=com",
      "CN=VPN-Users,OU=Groups,DC=corp,DC=example,DC=com"
    ],
    "enabled": true,
    "lastLogon": "2024-01-15T08:30:00Z"
  }
]
```

### Get Single User

**Request:**

```
GET /ad/users/mmueller
```

**Response:**

```json
{
  "samAccountName": "mmueller",
  "displayName": "Max Mueller",
  "email": "m.mueller@example.com",
  "department": "IT",
  "title": "Software Engineer",
  "telephoneNumber": "+49 123 456789",
  "mobile": "+49 170 1234567",
  "office": "Building A, Room 123",
  "manager": "CN=Anna Schmidt,OU=Users,DC=corp,DC=example,DC=com",
  "directReports": [
    "CN=Lisa Weber,OU=Users,DC=corp,DC=example,DC=com"
  ],
  "memberOf": [
    "CN=IT-Team,OU=Groups,DC=corp,DC=example,DC=com"
  ],
  "enabled": true,
  "created": "2020-03-15T10:00:00Z",
  "lastLogon": "2024-01-15T08:30:00Z"
}
```

### List Groups

**Request:**

```
GET /ad/groups?filter=(name=IT*)
```

### Get Group Members

**Request:**

```
GET /ad/groups/IT-Team
```

**Response:**

```json
{
  "name": "IT-Team",
  "description": "IT Department",
  "members": [
    {
      "samAccountName": "mmueller",
      "displayName": "Max Mueller",
      "email": "m.mueller@example.com"
    },
    {
      "samAccountName": "aschmidt",
      "displayName": "Anna Schmidt",
      "email": "a.schmidt@example.com"
    }
  ]
}
```

## Security

### Service Account

Create a dedicated service account with minimal permissions:

```powershell
# PowerShell on Domain Controller
New-ADUser -Name "svc_edge_connector" `
    -Description "Service Account for Edge Connector" `
    -PasswordNeverExpires $true `
    -CannotChangePassword $true `
    -Enabled $true

# Read-only permissions on users/groups
Add-ADGroupMember -Identity "Domain Users" -Members "svc_edge_connector"
```

### Network

- Bridge API only internally accessible (not exposed to the internet)
- Prefer LDAPS (Port 636) for encrypted connection
- Edge Connector → Bridge API over internal network

### Sensitive Data

The response hook automatically removes:

- `objectGUID`, `objectSid` (internal IDs)
- `userAccountControl` (bitmask)
- `pwdLastSet`, `badPasswordTime` (security-relevant)

## Troubleshooting

### "LDAP connection failed"

1. Check network connection: `telnet dc01.corp.example.com 389`
2. Check firewall rules
3. Verify service account credentials

### "No users returned"

1. Check Base-DN (must match domain)
2. Check LDAP filter
3. Does service account have read permissions?

### "Authentication failed"

1. Bind user in DN format: `CN=user,OU=...,DC=...`
2. Or UPN format: `user@corp.example.com`
3. Is the password correct?

## Extensions

### Additional Attributes

Add attributes in `bridge/config.py`:

```python
USER_ATTRIBUTES = [
    "samAccountName",
    "displayName",
    "mail",
    # Additional attributes:
    "employeeID",
    "company",
    "physicalDeliveryOfficeName",
]
```

### Caching

For better performance, the Bridge API can cache results:

```python
from functools import lru_cache

@lru_cache(maxsize=1000, ttl=300)  # 5 minute cache
def get_user(samname: str) -> dict:
    ...
```

### Webhook on Changes

For real-time updates, you can use AD notifications (requires additional
configuration).

## Node.js development

From the connector root, run `yarn install --immutable`, `yarn build`, and
`yarn check:templates`. The examples use the built SDK through Yarn workspaces.
When copying an example outside this checkout, replace its SDK dependency with a
`file:` reference to the SDK in a built, pinned connector checkout, then run
`yarn install` in the copied project.

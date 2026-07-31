# ERP Integration (SAP)

This example shows integration with SAP systems via OData endpoints.

## Architecture

```
FLAMOX365 Cloud
      │
      │  GET /erp/customers/12345
      │  POST /erp/orders
      ▼
Edge Connector (Function Mode)
      │
      │  → /sap/opu/odata/sap/...
      │  → Basic Auth + SAP-specific headers
      │  → Normalize OData response
      ▼
SAP Gateway (OData)
      │
      ▼
SAP ERP Backend
```

## Project Structure

```
erp-integration/
├── deno.json
├── docker-compose.yml
├── .env.example
└── functions/
    ├── health.ts           # GET /health
    ├── _shared/
    │   └── sap.ts          # SAP utilities (headers, OData parsing)
    └── erp/
        ├── customers/
        │   ├── index.ts    # GET/POST /erp/customers
        │   └── [id].ts     # GET/PUT/DELETE /erp/customers/:id
        ├── orders/
        │   └── index.ts    # GET /erp/orders
        └── products/
            └── index.ts    # GET /erp/products
```

## Configuration

Environment variables in `.env`:

```env
# FLAMOX365 Cloud WebSocket
FLAMOX_WS_URL=wss://api.example.com/connector/ws?tenant=your-tenant

# SAP Connection
ERP_URL=https://sap-gateway.example.com
ERP_USER=svc_edge_connector
ERP_PASSWORD=your-password
ERP_SYSTEM=PRD
```

## Supported Endpoints

| Cloud Path           | SAP OData Path                                       | Methods          |
| -------------------- | ---------------------------------------------------- | ---------------- |
| `/erp/customers`     | `/sap/opu/odata/sap/CUSTOMERS_SRV/CustomerSet`       | GET, POST        |
| `/erp/customers/:id` | `/sap/opu/odata/sap/CUSTOMERS_SRV/CustomerSet('id')` | GET, PUT, DELETE |
| `/erp/orders`        | `/sap/opu/odata/sap/ORDERS_SRV/OrderSet`             | GET              |
| `/erp/products`      | `/sap/opu/odata/sap/MATERIALS_SRV/MaterialSet`       | GET              |

## Start

```bash
# Create configuration
cp .env.example .env
nano .env

# Start
docker-compose up -d

# Logs
docker-compose logs -f
```

## Test

```bash
# Health check
curl http://localhost:8080/health

# All customers
curl http://localhost:8080/erp/customers

# Single customer
curl http://localhost:8080/erp/customers/12345

# Create customer
curl -X POST http://localhost:8080/erp/customers \
  -H "Content-Type: application/json" \
      -d '{"Name": "Example Ltd", "City": "London"}'
```

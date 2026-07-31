const nullableText = { type: ["string", "null"] } as const;

const providerData = {
  type: "object",
  additionalProperties: true,
} as const;

const callRecord = {
  type: "object",
  additionalProperties: false,
  required: [
    "callIntentId",
    "externalRecordId",
    "externalCallId",
    "providerRecordType",
    "direction",
    "category",
    "callerNumber",
    "calleeNumber",
    "actorExternalId",
    "actorAddress",
    "actorDisplayName",
    "startedAt",
    "endedAt",
    "connectedDurationSeconds",
    "conferenceExternalId",
    "carrier",
    "charge",
    "connectionCharge",
    "currency",
    "tenantCountryCode",
    "usageCountryCode",
    "destinationCountryCode",
    "extensions",
  ],
  properties: {
    callIntentId: nullableText,
    externalRecordId: { type: "string", minLength: 1, maxLength: 512 },
    externalCallId: nullableText,
    providerRecordType: { type: "string", minLength: 1, maxLength: 128 },
    direction: { enum: ["INBOUND", "OUTBOUND", "UNKNOWN"] },
    category: { enum: ["USER_PSTN", "CONFERENCE", "OTHER"] },
    callerNumber: nullableText,
    calleeNumber: nullableText,
    actorExternalId: nullableText,
    actorAddress: nullableText,
    actorDisplayName: nullableText,
    startedAt: { type: "string", minLength: 1, maxLength: 64 },
    endedAt: nullableText,
    connectedDurationSeconds: {
      type: ["integer", "null"],
      minimum: 0,
      maximum: 604800,
    },
    conferenceExternalId: nullableText,
    carrier: nullableText,
    charge: nullableText,
    connectionCharge: nullableText,
    currency: nullableText,
    tenantCountryCode: nullableText,
    usageCountryCode: nullableText,
    destinationCountryCode: nullableText,
    extensions: providerData,
  },
} as const;

export const TELEPHONY_PROVIDER_OPERATION_SCHEMAS = {
  startCall: {
    input: {
      type: "object",
      additionalProperties: false,
      required: ["callIntentId", "phoneNumber", "actor"],
      properties: {
        callIntentId: { type: "string", minLength: 1, maxLength: 128 },
        phoneNumber: { type: "string", minLength: 1, maxLength: 64 },
        actor: {
          type: "object",
          additionalProperties: false,
          required: ["userId", "address", "displayName"],
          properties: {
            userId: { type: "string", minLength: 1, maxLength: 128 },
            address: nullableText,
            displayName: nullableText,
          },
        },
      },
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: ["status", "providerCallId", "occurredAt"],
      properties: {
        status: { enum: ["ACCEPTED", "RINGING", "CONNECTED", "FAILED"] },
        providerCallId: nullableText,
        occurredAt: { type: "string", minLength: 1, maxLength: 64 },
        providerData,
      },
    },
  },
  endCall: {
    input: {
      type: "object",
      additionalProperties: false,
      required: ["callIntentId", "providerCallId"],
      properties: {
        callIntentId: { type: "string", minLength: 1, maxLength: 128 },
        providerCallId: nullableText,
      },
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: ["status", "occurredAt"],
      properties: {
        status: { enum: ["ACCEPTED", "ENDED", "FAILED"] },
        occurredAt: { type: "string", minLength: 1, maxLength: 64 },
        providerData,
      },
    },
  },
  synchronizeCalls: {
    input: {
      type: "object",
      additionalProperties: false,
      required: ["cursor", "maximumRecords"],
      properties: {
        cursor: { type: ["object", "null"], additionalProperties: true },
        maximumRecords: { type: "integer", minimum: 1, maximum: 1000 },
      },
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: ["calls", "cursor"],
      properties: {
        calls: { type: "array", maxItems: 1000, items: callRecord },
        cursor: providerData,
      },
    },
  },
  health: {
    input: { type: "null" },
    output: {
      type: "object",
      additionalProperties: false,
      required: ["healthy", "message"],
      properties: {
        healthy: { type: "boolean" },
        message: nullableText,
        providerData,
      },
    },
  },
} as const;

export type TelephonyProviderOperation =
  keyof typeof TELEPHONY_PROVIDER_OPERATION_SCHEMAS;

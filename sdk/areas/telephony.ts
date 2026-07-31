import {
  defineExtension,
  type ExtensionActionContext,
  type ExtensionActionHandler,
  type ExtensionDefinition,
  type JsonValue,
} from "../extension.ts";

export const TELEPHONY_AREA = "telephony";
export const TELEPHONY_PROVIDER_CONTRACT = "telephony.provider";
export const TELEPHONY_PROVIDER_CONTRACT_VERSION = 1;

export type TelephonyStartCallRequest = {
  readonly callIntentId: string;
  readonly phoneNumber: string;
  readonly actor: {
    readonly userId: string;
    readonly address: string | null;
    readonly displayName: string | null;
  };
};

export type TelephonyStartCallResult = {
  readonly status: "ACCEPTED" | "RINGING" | "CONNECTED" | "FAILED";
  readonly providerCallId: string | null;
  readonly occurredAt: string;
  readonly providerData?: Record<string, JsonValue>;
};

export type TelephonyEndCallRequest = {
  readonly callIntentId: string;
  readonly providerCallId: string | null;
};

export type TelephonyEndCallResult = {
  readonly status: "ACCEPTED" | "ENDED" | "FAILED";
  readonly occurredAt: string;
  readonly providerData?: Record<string, JsonValue>;
};

export type TelephonySynchronizeCallsRequest = {
  readonly cursor: Record<string, JsonValue> | null;
  readonly maximumRecords: number;
};

export type TelephonyCallRecord = {
  readonly callIntentId: string | null;
  readonly externalRecordId: string;
  readonly externalCallId: string | null;
  readonly providerRecordType: string;
  readonly direction: "INBOUND" | "OUTBOUND" | "UNKNOWN";
  readonly category: "USER_PSTN" | "CONFERENCE" | "OTHER";
  readonly callerNumber: string | null;
  readonly calleeNumber: string | null;
  readonly actorExternalId: string | null;
  readonly actorAddress: string | null;
  readonly actorDisplayName: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly connectedDurationSeconds: number | null;
  readonly conferenceExternalId: string | null;
  readonly carrier: string | null;
  readonly charge: string | null;
  readonly connectionCharge: string | null;
  readonly currency: string | null;
  readonly tenantCountryCode: string | null;
  readonly usageCountryCode: string | null;
  readonly destinationCountryCode: string | null;
  readonly extensions: Record<string, JsonValue>;
};

export type TelephonySynchronizeCallsResult = {
  readonly calls: TelephonyCallRecord[];
  readonly cursor: Record<string, JsonValue>;
};

export type TelephonyHealthRequest = null;

export type TelephonyHealthResult = {
  readonly healthy: boolean;
  readonly message: string | null;
  readonly providerData?: Record<string, JsonValue>;
};

type TelephonyOperation<TInput extends JsonValue, TOutput extends JsonValue> = {
  readonly action: string;
  readonly handler: (
    context: ExtensionActionContext,
    input: TInput,
  ) => TOutput | Promise<TOutput>;
};

export type TelephonyProviderDefinition = {
  readonly startCall: TelephonyOperation<
    TelephonyStartCallRequest,
    TelephonyStartCallResult
  >;
  readonly endCall: TelephonyOperation<
    TelephonyEndCallRequest,
    TelephonyEndCallResult
  >;
  readonly synchronizeCalls: TelephonyOperation<
    TelephonySynchronizeCallsRequest,
    TelephonySynchronizeCallsResult
  >;
  readonly health: TelephonyOperation<
    TelephonyHealthRequest,
    TelephonyHealthResult
  >;
  readonly actions?: Readonly<Record<string, ExtensionActionHandler>>;
};

/** Defines a provider whose operation handlers implement the telephony v1 contract. */
export function defineTelephonyProvider(
  definition: TelephonyProviderDefinition,
): ExtensionDefinition {
  const actions: Record<string, ExtensionActionHandler> = {
    ...(definition.actions ?? {}),
  };
  register(actions, definition.startCall);
  register(actions, definition.endCall);
  register(actions, definition.synchronizeCalls);
  register(actions, definition.health);
  return defineExtension({ actions });
}

function register<TInput extends JsonValue, TOutput extends JsonValue>(
  actions: Record<string, ExtensionActionHandler>,
  operation: TelephonyOperation<TInput, TOutput>,
): void {
  if (actions[operation.action]) {
    throw new Error(
      `Telephony operation action '${operation.action}' is declared more than once.`,
    );
  }
  actions[operation.action] = (context, input) =>
    operation.handler(context, input as TInput);
}

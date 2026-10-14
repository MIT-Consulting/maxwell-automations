import type {
  ResolvedWakeHookConfig,
  WakeHookDeliveryRecord,
  WakeHookPublic,
  WakeHooksPublic,
} from "@lca/shared";
import type { WakeHookDoctorContext } from "../notify/wake-hooks.js";

const MAX_DELIVERIES = 20;

export type WakeHookDeliveryRing = Map<string, WakeHookDeliveryRecord[]>;

/** Build the public GET snapshot (never includes token value or full URL). */
export function buildWakeHooksPublic(
  hooks: readonly ResolvedWakeHookConfig[],
  deliveryRings: WakeHookDeliveryRing,
  doctorContext?: (hook: ResolvedWakeHookConfig) => WakeHookDoctorContext
): WakeHooksPublic {
  return {
    hooks: hooks.map((hook): WakeHookPublic => {
      const lastDeliveries = (deliveryRings.get(hook.id) ?? []).slice(
        -MAX_DELIVERIES
      );
      let urlHost: string | undefined;
      if (hook.url != null) {
        try {
          urlHost = new URL(hook.url).origin;
        } catch {
          urlHost = undefined;
        }
      }
      const doctor = doctorContext?.(hook);
      return {
        id: hook.id,
        sink: hook.sink,
        events: hook.events,
        ...(urlHost !== undefined ? { urlHost } : {}),
        ...(hook.chatId !== undefined ? { chatId: hook.chatId } : {}),
        ...(hook.tokenEnv !== undefined ? { tokenEnv: hook.tokenEnv } : {}),
        ...(doctor?.actorId !== undefined ? { actorId: doctor.actorId } : {}),
        ...(doctor?.noActorActivitySince === true
          ? { noActorActivitySince: true }
          : {}),
        lastDeliveries,
      };
    }),
  };
}

import type {
  EventCurriculumBindingSnapshotResponse,
  LearningDayId,
  ProgrammeDayId,
} from "../../shared/api.js";
import type {
  EventCurriculumBindingSnapshot,
  EventCurriculumBindingStore,
} from "./event-binding-store.js";

const EVENT_BINDING_ID_PATTERN = /^aisb-\d{4}-\d{3}$/;
const SECTION_ID_PATTERN = /^(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})$/;

interface ScheduleEventForBinding {
  readonly eventBindingId: string;
  readonly programmeDayId: ProgrammeDayId | null;
  readonly status: "scheduled" | "cancelled";
}

export interface EventBindingScheduleSnapshot {
  readonly scheduleRevision: string;
  readonly events: readonly ScheduleEventForBinding[];
}

export interface EventBindingScheduleSource {
  readonly withSnapshotAtRevision: <T>(
    expectedRevision: string,
    operation: (snapshot: EventBindingScheduleSnapshot) => Promise<T>,
  ) => Promise<T>;
}

export interface EventBindingCurriculumSource {
  readonly readDay: (
    dayId: LearningDayId,
  ) => Promise<readonly { readonly sectionId: string }[]>;
}

export interface EventBindingStorePort {
  readonly read: EventCurriculumBindingStore["read"];
  readonly replace: EventCurriculumBindingStore["replace"];
  readonly clear: EventCurriculumBindingStore["clear"];
}

export class EventCurriculumBindingServiceError extends Error {
  public constructor(
    public readonly code:
      | "invalid_request"
      | "event_not_found"
      | "event_not_linkable"
      | "section_not_available",
    message: string,
    public readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "EventCurriculumBindingServiceError";
  }
}

export function eventCurriculumBindingResponse(
  snapshot: Readonly<EventCurriculumBindingSnapshot>,
): EventCurriculumBindingSnapshotResponse {
  return Object.freeze({
    schemaVersion: 1 as const,
    revision: snapshot.revision,
    bindings: Object.freeze(
      snapshot.bindings.map((binding) =>
        Object.freeze({
          eventBindingId: binding.eventBindingId,
          sectionIds: Object.freeze([...binding.sectionIds]),
          source: "explicit" as const,
        }),
      ),
    ),
  });
}

/**
 * Validates explicit links against server-owned schedule and curriculum state.
 * No title, time, or folder-name inference is performed here.
 */
export class EventCurriculumBindingService {
  public constructor(
    private readonly store: EventBindingStorePort,
    private readonly schedule: EventBindingScheduleSource,
    private readonly curriculum: EventBindingCurriculumSource,
  ) {}

  public async read(): Promise<EventCurriculumBindingSnapshotResponse> {
    return eventCurriculumBindingResponse(await this.store.read());
  }

  public async replace(input: {
    readonly expectedRevision: string;
    readonly expectedScheduleRevision: string;
    readonly eventBindingId: string;
    readonly sectionIds: readonly string[];
  }): Promise<EventCurriculumBindingSnapshotResponse> {
    this.#validateRequest(input.eventBindingId, input.sectionIds);

    return this.schedule.withSnapshotAtRevision(
      input.expectedScheduleRevision,
      async (schedule) => {
        // Clearing remains permitted when the old target is stale. The
        // schedule revision is still held stable so the response describes
        // one committed pair of schedule/binding states.
        if (input.sectionIds.length === 0) {
          return eventCurriculumBindingResponse(
            await this.store.clear(input.expectedRevision, input.eventBindingId),
          );
        }

        const event = schedule.events.find(
          (candidate) => candidate.eventBindingId === input.eventBindingId,
        );
        if (event === undefined) {
          throw new EventCurriculumBindingServiceError(
            "event_not_found",
            "The selected schedule event no longer exists. Refresh before linking material.",
            404,
          );
        }
        if (event.status !== "scheduled" || event.programmeDayId === null) {
          throw new EventCurriculumBindingServiceError(
            "event_not_linkable",
            "Only a scheduled event assigned to a programme day can be linked to material.",
            409,
          );
        }

        const availableSections = new Set(
          (await this.curriculum.readDay(event.programmeDayId)).map((section) => section.sectionId),
        );
        const unavailable = input.sectionIds.filter((sectionId) => !availableSections.has(sectionId));
        if (unavailable.length > 0) {
          throw new EventCurriculumBindingServiceError(
            "section_not_available",
            `The selected material is not available for the event's current programme day: ${unavailable.join(
              ", ",
            )}. Refresh before linking material.`,
            409,
          );
        }

        return eventCurriculumBindingResponse(
          await this.store.replace(
            input.expectedRevision,
            input.eventBindingId,
            input.sectionIds,
          ),
        );
      },
    );
  }

  #validateRequest(eventBindingId: string, sectionIds: readonly string[]): void {
    if (!EVENT_BINDING_ID_PATTERN.test(eventBindingId)) {
      throw new EventCurriculumBindingServiceError(
        "invalid_request",
        "The event binding identifier is invalid.",
        400,
      );
    }
    if (
      sectionIds.length > 64 ||
      sectionIds.some((sectionId) => !SECTION_ID_PATTERN.test(sectionId)) ||
      new Set(sectionIds).size !== sectionIds.length
    ) {
      throw new EventCurriculumBindingServiceError(
        "invalid_request",
        "Section identifiers must be an ordered, unique list of valid curriculum section IDs.",
        400,
      );
    }
  }
}

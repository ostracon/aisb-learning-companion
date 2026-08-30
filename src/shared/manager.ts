export interface ManagerSessionMessageView {
  readonly messageId: string;
  readonly role: "user" | "assistant" | "status";
  readonly text: string;
  readonly occurredAt: string;
  readonly turnNonce: string;
  readonly turnId: string | null;
}

export interface ManagerSessionView {
  readonly chatId: string | null;
  readonly threadId: string | null;
  readonly messages: readonly ManagerSessionMessageView[];
  readonly unresolvedTurn: {
    readonly submittedAt: string;
  } | null;
}

export interface ManagerTurnRequest {
  readonly clientUserMessageId: string;
  readonly message: string;
}

export interface ManagerTurnResponse {
  readonly message: string;
  readonly chatId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly clientUserMessageId: string;
  readonly contextHash: string;
}

export interface ManagerContextProjection {
  readonly schema: "aisb-learning-companion.manager-context.v1";
  readonly generatedAt: string;
  readonly schedule: {
    readonly revision: string;
    readonly events: readonly {
      readonly dayId: string | null;
      readonly title: string;
      readonly start: string;
      readonly end: string;
      readonly status: "scheduled" | "cancelled";
    }[];
  };
  readonly outcomes: readonly {
    readonly outcomeId: string;
    readonly versionId: string;
    readonly sectionId: string;
    readonly category: "engineering" | "ml" | "security" | "theory";
    readonly text: string;
    readonly checked: boolean;
  }[];
  readonly notes: readonly {
    readonly noteId: string;
    readonly title: string;
    readonly logicalPath: string;
    readonly revision: number;
    readonly excerpt: string;
    readonly truncated: boolean;
  }[];
  readonly approvedContinuity: readonly {
    readonly sourceDayId: string;
    readonly approvedAt: string;
    readonly text: string;
  }[];
  readonly preparedReferences: readonly {
    readonly sourceId: string;
    readonly title: string;
    readonly url: string;
    readonly status: "cached" | "not_fetched" | "unsupported" | "failed";
    readonly contentHash: string | null;
    readonly excerpt: string | null;
    readonly truncated: boolean;
    readonly detail: string;
  }[];
  readonly priorTutorChats: readonly {
    readonly scopeKey: string;
    readonly latestActivityAt: string;
    readonly messages: readonly {
      readonly role: "learner" | "tutor" | "status";
      readonly text: string;
      readonly occurredAt: string;
      readonly truncated: boolean;
    }[];
  }[];
  readonly reviewSummaries: readonly {
    readonly sessionId: string;
    readonly updatedAt: string | null;
    readonly outcomes: readonly {
      readonly outcomeId: string;
      readonly sectionId: string;
      readonly category: "engineering" | "ml" | "security" | "theory";
      readonly text: string;
      readonly truncated: boolean;
    }[];
    readonly questionsAsked: number;
    readonly questionLimit: number;
    readonly responsesRecorded: number;
    readonly complete: boolean;
    readonly recentFeedback: {
      readonly text: string;
      readonly outcomeIds: readonly string[];
      readonly assessmentAuthority: "advisory";
      readonly truncated: boolean;
    } | null;
  }[];
  readonly omissions: readonly string[];
}

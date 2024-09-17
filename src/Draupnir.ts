// Copyright 2022 - 2023 Gnuxie <Gnuxie@protonmail.com>
// Copyright 2019 - 2021 The Matrix.org Foundation C.I.C.
//
// SPDX-License-Identifier: AFL-3.0 AND Apache-2.0
//
// SPDX-FileAttributionText: <text>
// This modified file incorporates work from mjolnir
// https://github.com/matrix-org/mjolnir
// </text>

import {
  ActionResult,
  Client,
  ClientPlatform,
  ClientRooms,
  EventReport,
  LoggableConfigTracker,
  Logger,
  MembershipEvent,
  Ok,
  PolicyRoomManager,
  ProtectedRoomsSet,
  RoomEvent,
  RoomMembershipManager,
  RoomMembershipRevisionIssuer,
  RoomMessage,
  RoomStateManager,
  Task,
  TextMessageContent,
  Value,
  isError,
} from "matrix-protection-suite";
import { UnlistedUserRedactionQueue } from "./queues/UnlistedUserRedactionQueue";
import { ThrottlingQueue } from "./queues/ThrottlingQueue";
import ManagementRoomOutput from "./ManagementRoomOutput";
import { ReportPoller } from "./report/ReportPoller";
import { ReportManager } from "./report/ReportManager";
import { MatrixReactionHandler } from "./commands/interface-manager/MatrixReactionHandler";
import {
  MatrixSendClient,
  SynapseAdminClient,
} from "matrix-protection-suite-for-matrix-bot-sdk";
import { IConfig } from "./config";
import { LogLevel } from "matrix-bot-sdk";
import {
  ARGUMENT_PROMPT_LISTENER,
  DEFAUILT_ARGUMENT_PROMPT_LISTENER,
  makeListenerForArgumentPrompt as makeListenerForArgumentPrompt,
  makeListenerForPromptDefault,
} from "./commands/interface-manager/MatrixPromptForAccept";
import { RendererMessageCollector } from "./capabilities/RendererMessageCollector";
import { DraupnirRendererMessageCollector } from "./capabilities/DraupnirRendererMessageCollector";
import { renderProtectionFailedToStart } from "./protections/ProtectedRoomsSetRenderers";
import { draupnirStatusInfo, renderStatusInfo } from "./commands/StatusCommand";
import { isInvitationForUser } from "./protections/invitation/inviteCore";
import {
  StringRoomID,
  StringUserID,
  MatrixRoomID,
  isStringRoomID,
  isStringRoomAlias,
  MatrixRoomReference,
  userServerName,
} from "@the-draupnir-project/matrix-basic-types";
import {
  MatrixAdaptorContext,
  sendMatrixEventsFromDeadDocument,
} from "./commands/interface-manager/MPSMatrixInterfaceAdaptor";
import { makeDraupnirCommandDispatcher } from "./commands/DraupnirCommandDispatcher";
import { SafeModeToggle } from "./safemode/SafeModeToggle";

const log = new Logger("Draupnir");

// webAPIS should not be included on the Draupnir class.
// That should be managed elsewhere.
// It's not actually relevant to the Draupnir instance and it only was connected
// to Mjolnir because it needs to be started after Mjolnir started and not before.
// And giving it to the class was a dumb easy way of doing that.

export class Draupnir implements Client, MatrixAdaptorContext {
  /**
   * This is for users who are not listed on a watchlist,
   * but have been flagged by the automatic spam detection as suispicous
   */
  public unlistedUserRedactionQueue = new UnlistedUserRedactionQueue();

  private readonly commandDispatcher = makeDraupnirCommandDispatcher(this);
  public taskQueue: ThrottlingQueue;
  /**
   * Reporting back to the management room.
   */
  public readonly managementRoomOutput: ManagementRoomOutput;
  public readonly managementRoomID: StringRoomID;
  /*
   * Config-enabled polling of reports in Synapse, so Mjolnir can react to reports
   */
  private reportPoller?: ReportPoller;
  /**
   * Handle user reports from the homeserver.
   * FIXME: ReportManager should be a protection.
   */
  public readonly reportManager: ReportManager;

  public readonly reactionHandler: MatrixReactionHandler;

  private readonly timelineEventListener = this.handleTimelineEvent.bind(this);

  public readonly capabilityMessageRenderer: RendererMessageCollector;

  private constructor(
    public readonly client: MatrixSendClient,
    public readonly clientUserID: StringUserID,
    public readonly clientPlatform: ClientPlatform,
    public readonly managementRoom: MatrixRoomID,
    public readonly clientRooms: ClientRooms,
    public readonly config: IConfig,
    public readonly protectedRoomsSet: ProtectedRoomsSet,
    public readonly roomStateManager: RoomStateManager,
    public readonly policyRoomManager: PolicyRoomManager,
    public readonly roomMembershipManager: RoomMembershipManager,
    public readonly loggableConfigTracker: LoggableConfigTracker,
    /** Mjolnir has a feature where you can choose to accept invitations from a space and not just the management room. */
    public readonly acceptInvitesFromRoom: MatrixRoomID,
    public readonly acceptInvitesFromRoomIssuer: RoomMembershipRevisionIssuer,
    public readonly safeModeToggle: SafeModeToggle,
    public readonly synapseAdminClient?: SynapseAdminClient
  ) {
    this.managementRoomID = this.managementRoom.toRoomIDOrAlias();
    this.managementRoomOutput = new ManagementRoomOutput(
      this.managementRoomID,
      this.clientUserID,
      this.client,
      this.config
    );
    this.taskQueue = new ThrottlingQueue(
      this.managementRoomOutput,
      config.backgroundDelayMS
    );
    this.reactionHandler = new MatrixReactionHandler(
      this.managementRoom.toRoomIDOrAlias(),
      client,
      clientUserID,
      clientPlatform
    );
    this.reportManager = new ReportManager(this);
    if (config.pollReports) {
      this.reportPoller = new ReportPoller(this, this.reportManager);
    }
    this.reactionHandler.on(
      ARGUMENT_PROMPT_LISTENER,
      makeListenerForArgumentPrompt(this.commandDispatcher)
    );
    this.reactionHandler.on(
      DEFAUILT_ARGUMENT_PROMPT_LISTENER,
      makeListenerForPromptDefault(this.commandDispatcher)
    );
    this.capabilityMessageRenderer = new DraupnirRendererMessageCollector(
      this.clientPlatform.toRoomMessageSender(),
      this.managementRoomID
    );
  }

  public static async makeDraupnirBot(
    client: MatrixSendClient,
    clientUserID: StringUserID,
    clientPlatform: ClientPlatform,
    managementRoom: MatrixRoomID,
    clientRooms: ClientRooms,
    protectedRoomsSet: ProtectedRoomsSet,
    roomStateManager: RoomStateManager,
    policyRoomManager: PolicyRoomManager,
    roomMembershipManager: RoomMembershipManager,
    config: IConfig,
    loggableConfigTracker: LoggableConfigTracker,
    safeModeToggle: SafeModeToggle
  ): Promise<ActionResult<Draupnir>> {
    const acceptInvitesFromRoom = await (async () => {
      if (config.autojoinOnlyIfManager) {
        return Ok(managementRoom);
      } else {
        if (config.acceptInvitesFromSpace === undefined) {
          throw new TypeError(
            `You cannot leave config.acceptInvitesFromSpace undefined if you have disabled config.autojoinOnlyIfManager`
          );
        }
        const room = (() => {
          if (
            isStringRoomID(config.acceptInvitesFromSpace) ||
            isStringRoomAlias(config.acceptInvitesFromSpace)
          ) {
            return config.acceptInvitesFromSpace;
          } else {
            const parseResult = MatrixRoomReference.fromPermalink(
              config.acceptInvitesFromSpace
            );
            if (isError(parseResult)) {
              throw new TypeError(
                `config.acceptInvitesFromSpace: ${config.acceptInvitesFromSpace} needs to be a room id, alias or permalink`
              );
            }
            return parseResult.ok;
          }
        })();
        return await clientPlatform.toRoomJoiner().joinRoom(room);
      }
    })();
    if (isError(acceptInvitesFromRoom)) {
      return acceptInvitesFromRoom;
    }
    const acceptInvitesFromRoomIssuer =
      await roomMembershipManager.getRoomMembershipRevisionIssuer(
        acceptInvitesFromRoom.ok
      );
    if (isError(acceptInvitesFromRoomIssuer)) {
      return acceptInvitesFromRoomIssuer;
    }
    const draupnir = new Draupnir(
      client,
      clientUserID,
      clientPlatform,
      managementRoom,
      clientRooms,
      config,
      protectedRoomsSet,
      roomStateManager,
      policyRoomManager,
      roomMembershipManager,
      loggableConfigTracker,
      acceptInvitesFromRoom.ok,
      acceptInvitesFromRoomIssuer.ok,
      safeModeToggle,
      new SynapseAdminClient(client, clientUserID)
    );
    const loadResult = await protectedRoomsSet.protections.loadProtections(
      protectedRoomsSet,
      draupnir,
      (error, protectionName, description) =>
        renderProtectionFailedToStart(
          clientPlatform.toRoomMessageSender(),
          managementRoom.toRoomIDOrAlias(),
          error,
          protectionName,
          description
        )
    );
    if (isError(loadResult)) {
      return loadResult;
    }
    // we need to make sure that we are protecting the management room so we
    // have immediate access to its membership (for accepting invitations).
    const managementRoomProtectResult =
      await draupnir.protectedRoomsSet.protectedRoomsManager.addRoom(
        managementRoom
      );
    if (isError(managementRoomProtectResult)) {
      return managementRoomProtectResult;
    }
    return Ok(draupnir);
  }

  /**
   * Note: This is only public due to having to first start the syncloop before sending events
   * when we use encryption.
   * This means this is only used in the index.ts.
   */
  public async startupComplete(): Promise<void> {
    const statusInfo = await draupnirStatusInfo(this);
    try {
      await this.managementRoomOutput.logMessage(
        LogLevel.INFO,
        "Mjolnir@startup",
        "Startup complete. Now monitoring rooms."
      );
      await sendMatrixEventsFromDeadDocument(
        this.clientPlatform.toRoomMessageSender(),
        this.managementRoomID,
        renderStatusInfo(statusInfo),
        {}
      );
    } catch (ex) {
      log.error(`Caught an error when trying to show status at startup`, ex);
    }
  }

  public handleTimelineEvent(roomID: StringRoomID, event: RoomEvent): void {
    if (
      Value.Check(MembershipEvent, event) &&
      isInvitationForUser(event, this.clientUserID)
    ) {
      this.protectedRoomsSet.handleExternalInvite(roomID, event);
    }
    this.managementRoomMessageListener(roomID, event);
    void Task(
      (async () => {
        await this.reactionHandler.handleEvent(roomID, event);
      })()
    );
    if (this.protectedRoomsSet.isProtectedRoom(roomID)) {
      this.protectedRoomsSet.handleTimelineEvent(roomID, event);
    }
  }

  private managementRoomMessageListener(
    roomID: StringRoomID,
    event: RoomEvent
  ): void {
    if (roomID !== this.managementRoomID) {
      return;
    }
    if (
      Value.Check(RoomMessage, event) &&
      Value.Check(TextMessageContent, event.content)
    ) {
      if (
        event.content.body ===
        "** Unable to decrypt: The sender's device has not sent us the keys for this message. **"
      ) {
        log.info(
          `Unable to decrypt an event ${event.event_id} from ${event.sender} in the management room ${this.managementRoom.toPermalink()}.`
        );
        void Task(
          this.client.unstableApis
            .addReactionToEvent(roomID, event.event_id, "⚠")
            .then((_) => Ok(undefined))
        );
        void Task(
          this.client.unstableApis
            .addReactionToEvent(roomID, event.event_id, "UISI")
            .then((_) => Ok(undefined))
        );
        void Task(
          this.client.unstableApis
            .addReactionToEvent(roomID, event.event_id, "🚨")
            .then((_) => Ok(undefined))
        );
        return;
      }
      this.commandDispatcher.handleCommandMessageEvent(
        {
          event,
          roomID,
        },
        event.content.body
      );
    }
    this.reportManager.handleTimelineEvent(roomID, event);
  }

  /**
   * Start responding to events.
   * This will not start the appservice from listening and responding
   * to events. Nor will it start any syncing client.
   */
  public async start(): Promise<void> {
    this.clientRooms.on("timeline", this.timelineEventListener);
    if (this.reportPoller) {
      const reportPollSetting = await ReportPoller.getReportPollSetting(
        this.client,
        this.managementRoomOutput
      );
      this.reportPoller.start(reportPollSetting);
    }
  }

  public stop(): void {
    this.clientRooms.off("timeline", this.timelineEventListener);
    this.reportPoller?.stop();
  }

  public createRoomReference(roomID: StringRoomID): MatrixRoomID {
    return new MatrixRoomID(roomID, [userServerName(this.clientUserID)]);
  }
  public handleEventReport(report: EventReport): void {
    this.protectedRoomsSet.handleEventReport(report);
  }

  /**
   * This is needed to implement the MatrixInterfaceAdaptor interface.
   */
  public get commandRoomID() {
    return this.managementRoomID;
  }
}

// SPDX-FileCopyrightText: 2024 Gnuxie <Gnuxie@protonmail.com>
//
// SPDX-License-Identifier: AFL-3.0

import {
  ClientPlatform,
  ClientRooms,
  EventReport,
  RoomEvent,
  Task,
} from "matrix-protection-suite";
import {
  MatrixAdaptorContext,
  sendMatrixEventsFromDeadDocument,
} from "../commands/interface-manager/MPSMatrixInterfaceAdaptor";
import {
  StringUserID,
  StringRoomID,
  MatrixRoomID,
} from "@the-draupnir-project/matrix-basic-types";
import { MatrixSendClient } from "matrix-protection-suite-for-matrix-bot-sdk";
import { MatrixReactionHandler } from "../commands/interface-manager/MatrixReactionHandler";
import { IConfig } from "../config";
import { SafeModeCause } from "./SafeModeCause";
import { makeSafeModeCommandDispatcher } from "./SafeModeCommandDispatcher";
import {
  ARGUMENT_PROMPT_LISTENER,
  DEFAUILT_ARGUMENT_PROMPT_LISTENER,
  makeListenerForArgumentPrompt,
  makeListenerForPromptDefault,
} from "../commands/interface-manager/MatrixPromptForAccept";
import { makeCommandDispatcherTimelineListener } from "./ManagementRoom";
import { SafeModeToggle } from "./SafeModeToggle";
import { Result } from "@gnuxie/typescript-result";
import {
  renderSafeModeStatusInfo,
  safeModeStatusInfo,
} from "./commands/StatusCommand";
import { wrapInRoot } from "../commands/interface-manager/MatrixHelpRenderer";

export class SafeModeDraupnir implements MatrixAdaptorContext {
  public reactionHandler: MatrixReactionHandler;
  private readonly timelineEventListener = this.handleTimelineEvent.bind(this);
  private readonly commandDispatcher = makeSafeModeCommandDispatcher(this);
  private readonly commandDispatcherTimelineListener =
    makeCommandDispatcherTimelineListener(
      this.managementRoom,
      this.client,
      this.commandDispatcher
    );
  public constructor(
    public readonly cause: SafeModeCause,
    public readonly client: MatrixSendClient,
    public readonly clientUserID: StringUserID,
    public readonly clientPlatform: ClientPlatform,
    public readonly managementRoom: MatrixRoomID,
    private readonly clientRooms: ClientRooms,
    public readonly safeModeToggle: SafeModeToggle,
    public readonly config: IConfig
    //private readonly roomStateManager: RoomStateManager,
    //private readonly policyRoomManager: PolicyRoomManager,
    //private readonly roomMembershipManager: RoomMembershipManager,
  ) {
    this.reactionHandler = new MatrixReactionHandler(
      managementRoom.toRoomIDOrAlias(),
      client,
      this.clientUserID,
      this.clientPlatform
    );
    this.reactionHandler.on(
      ARGUMENT_PROMPT_LISTENER,
      makeListenerForArgumentPrompt(this.commandDispatcher)
    );
    this.reactionHandler.on(
      DEFAUILT_ARGUMENT_PROMPT_LISTENER,
      makeListenerForPromptDefault(this.commandDispatcher)
    );
  }

  handleTimelineEvent(roomID: StringRoomID, event: RoomEvent): void {
    this.commandDispatcherTimelineListener(roomID, event);
  }
  handleEventReport(_report: EventReport): void {
    throw new Error("Method not implemented.");
  }

  public get commandRoomID(): StringRoomID {
    return this.managementRoom.toRoomIDOrAlias();
  }

  /**
   * Start responding to events.
   * This will not start the appservice from listening and responding
   * to events. Nor will it start any syncing client.
   */
  public start(): void {
    this.clientRooms.on("timeline", this.timelineEventListener);
  }

  public stop(): void {
    this.clientRooms.off("timeline", this.timelineEventListener);
  }

  public sendStartupComplete(): void {
    void Task(
      sendMatrixEventsFromDeadDocument(
        this.clientPlatform.toRoomMessageSender(),
        this.commandRoomID,
        wrapInRoot(renderSafeModeStatusInfo(safeModeStatusInfo(this))),
        {}
      ) as Promise<Result<void>>
    );
  }
}

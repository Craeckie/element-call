/*
Copyright 2022 Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import React, { useEffect, useCallback, useMemo, useRef } from "react";
import { usePreventScroll } from "@react-aria/overlays";
import useMeasure from "react-use-measure";
import { ResizeObserver } from "@juggle/resize-observer";
import { MatrixClient } from "matrix-js-sdk/src/client";
import { RoomMember } from "matrix-js-sdk/src/models/room-member";
import { GroupCall } from "matrix-js-sdk/src/webrtc/groupCall";
import { CallFeed } from "matrix-js-sdk/src/webrtc/callFeed";
import classNames from "classnames";
import { useTranslation } from "react-i18next";
import { JoinRule } from "matrix-js-sdk/src/@types/partials";

import type { IWidgetApiRequest } from "matrix-widget-api";
import styles from "./InCallView.module.css";
import {
  HangupButton,
  MicButton,
  VideoButton,
  ScreenshareButton,
} from "../button";
import {
  Header,
  LeftNav,
  RightNav,
  RoomHeaderInfo,
  VersionMismatchWarning,
} from "../Header";
import { VideoGrid, useVideoGridLayout } from "../video-grid/VideoGrid";
import { VideoTileContainer } from "../video-grid/VideoTileContainer";
import { GroupCallInspector } from "./GroupCallInspector";
import { OverflowMenu } from "./OverflowMenu";
import { GridLayoutMenu } from "./GridLayoutMenu";
import { Avatar } from "../Avatar";
import { UserMenuContainer } from "../UserMenuContainer";
import { useRageshakeRequestModal } from "../settings/submit-rageshake";
import { RageshakeRequestModal } from "./RageshakeRequestModal";
import { useMediaHandler } from "../settings/useMediaHandler";
import { useShowInspector, useSpatialAudio } from "../settings/useSetting";
import { useModalTriggerState } from "../Modal";
import { useAudioContext } from "../video-grid/useMediaStream";
import { useFullscreen } from "../video-grid/useFullscreen";
import { AudioContainer } from "../video-grid/AudioContainer";
import { useAudioOutputDevice } from "../video-grid/useAudioOutputDevice";
import { PosthogAnalytics } from "../PosthogAnalytics";
import { widget, ElementWidgetActions } from "../widget";
import { useJoinRule } from "./useJoinRule";
import { useUrlParams } from "../UrlParams";
import { usePrefersReducedMotion } from "../usePrefersReducedMotion";
import { ConnectionState, ParticipantInfo } from "./useGroupCall";

const canScreenshare = "getDisplayMedia" in (navigator.mediaDevices ?? {});
// There is currently a bug in Safari our our code with cloning and sending MediaStreams
// or with getUsermedia and getDisplaymedia being used within the same session.
// For now we can disable screensharing in Safari.
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

interface Props {
  client: MatrixClient;
  groupCall: GroupCall;
  participants: Map<RoomMember, Map<string, ParticipantInfo>>;
  roomName: string;
  avatarUrl: string;
  microphoneMuted: boolean;
  localVideoMuted: boolean;
  toggleLocalVideoMuted: () => void;
  toggleMicrophoneMuted: () => void;
  toggleScreensharing: () => void;
  userMediaFeeds: CallFeed[];
  activeSpeaker: CallFeed | null;
  onLeave: () => void;
  isScreensharing: boolean;
  screenshareFeeds: CallFeed[];
  roomIdOrAlias: string;
  unencryptedEventsFromUsers: Set<string>;
  hideHeader: boolean;
}

// Represents something that should get a tile on the layout,
// ie. a user's video feed or a screen share feed.
export interface TileDescriptor {
  id: string;
  member: RoomMember;
  focused: boolean;
  presenter: boolean;
  callFeed?: CallFeed;
  isLocal?: boolean;
  connectionState: ConnectionState;
}

export function InCallView({
  client,
  groupCall,
  participants,
  roomName,
  avatarUrl,
  microphoneMuted,
  localVideoMuted,
  toggleLocalVideoMuted,
  toggleMicrophoneMuted,
  userMediaFeeds,
  activeSpeaker,
  onLeave,
  toggleScreensharing,
  isScreensharing,
  screenshareFeeds,
  roomIdOrAlias,
  unencryptedEventsFromUsers,
  hideHeader,
}: Props) {
  const { t } = useTranslation();
  usePreventScroll();
  const joinRule = useJoinRule(groupCall.room);

  const containerRef1 = useRef<HTMLDivElement | null>(null);
  const [containerRef2, bounds] = useMeasure({ polyfill: ResizeObserver });
  const boundsValid = bounds.height > 0;
  // Merge the refs so they can attach to the same element
  const containerRef = useCallback(
    (el: HTMLDivElement) => {
      containerRef1.current = el;
      containerRef2(el);
    },
    [containerRef1, containerRef2]
  );

  const { layout, setLayout } = useVideoGridLayout(screenshareFeeds.length > 0);
  const { toggleFullscreen, fullscreenParticipant } =
    useFullscreen(containerRef1);

  const [spatialAudio] = useSpatialAudio();

  const [audioContext, audioDestination, audioRef] = useAudioContext();
  const { audioOutput } = useMediaHandler();
  const [showInspector] = useShowInspector();

  const { modalState: feedbackModalState, modalProps: feedbackModalProps } =
    useModalTriggerState();

  useAudioOutputDevice(audioRef, audioOutput);

  const { hideScreensharing } = useUrlParams();

  useEffect(() => {
    widget?.api.transport.send(
      layout === "freedom"
        ? ElementWidgetActions.TileLayout
        : ElementWidgetActions.SpotlightLayout,
      {}
    );
  }, [layout]);

  useEffect(() => {
    if (widget) {
      const onTileLayout = async (ev: CustomEvent<IWidgetApiRequest>) => {
        setLayout("freedom");
        await widget.api.transport.reply(ev.detail, {});
      };
      const onSpotlightLayout = async (ev: CustomEvent<IWidgetApiRequest>) => {
        setLayout("spotlight");
        await widget.api.transport.reply(ev.detail, {});
      };

      widget.lazyActions.on(ElementWidgetActions.TileLayout, onTileLayout);
      widget.lazyActions.on(
        ElementWidgetActions.SpotlightLayout,
        onSpotlightLayout
      );

      return () => {
        widget.lazyActions.off(ElementWidgetActions.TileLayout, onTileLayout);
        widget.lazyActions.off(
          ElementWidgetActions.SpotlightLayout,
          onSpotlightLayout
        );
      };
    }
  }, [setLayout]);

  const items = useMemo(() => {
    const tileDescriptors: TileDescriptor[] = [];
    const localUserId = client.getUserId()!;
    const localDeviceId = client.getDeviceId()!;

    // One tile for each participant, to start with (we want a tile for everyone we
    // think should be in the call, even if we don't have a call feed for them yet)
    for (const [member, participantMap] of participants) {
      for (const [deviceId, { connectionState, presenter }] of participantMap) {
        const callFeed = userMediaFeeds.find(
          (f) => f.userId === member.userId && f.deviceId === deviceId
        );

        tileDescriptors.push({
          id: `${member.userId} ${deviceId}`,
          member,
          callFeed,
          focused: screenshareFeeds.length === 0 && callFeed === activeSpeaker,
          isLocal: member.userId === localUserId && deviceId === localDeviceId,
          presenter,
          connectionState,
        });
      }
    }

    PosthogAnalytics.instance.eventCallEnded.cacheParticipantCountChanged(
      tileDescriptors.length
    );

    // Add the screenshares too
    for (const screenshareFeed of screenshareFeeds) {
      const member = screenshareFeed.getMember()!;
      const connectionState = participants
        .get(member)
        ?.get(screenshareFeed.deviceId!)?.connectionState;

      // If the participant has left, their screenshare feed is stale and we
      // shouldn't bother showing it
      if (connectionState !== undefined) {
        tileDescriptors.push({
          id: screenshareFeed.stream.id,
          member,
          callFeed: screenshareFeed,
          focused: true,
          isLocal: screenshareFeed.isLocal(),
          presenter: false,
          connectionState,
        });
      }
    }

    return tileDescriptors;
  }, [client, participants, userMediaFeeds, activeSpeaker, screenshareFeeds]);

  // The maximised participant: either the participant that the user has
  // manually put in fullscreen, or the focused (active) participant if the
  // window is too small to show everyone
  const maximisedParticipant = useMemo(
    () =>
      fullscreenParticipant ??
      (boundsValid && bounds.height <= 400 && bounds.width <= 400
        ? items.find((item) => item.focused) ??
          items.find((item) => item.callFeed) ??
          null
        : null),
    [fullscreenParticipant, boundsValid, bounds, items]
  );

  const reducedControls = boundsValid && bounds.width <= 400;

  const renderAvatar = useCallback(
    (roomMember: RoomMember, width: number, height: number) => {
      const avatarUrl = roomMember.getMxcAvatarUrl();
      const size = Math.round(Math.min(width, height) / 2);

      return (
        <Avatar
          key={roomMember.userId}
          size={size}
          src={avatarUrl ?? undefined}
          fallback={roomMember.name.slice(0, 1).toUpperCase()}
          className={styles.avatar}
        />
      );
    },
    []
  );

  const prefersReducedMotion = usePrefersReducedMotion();

  const renderContent = (): JSX.Element => {
    if (items.length === 0) {
      return (
        <div className={styles.centerMessage}>
          <p>{t("Waiting for other participants…")}</p>
        </div>
      );
    }
    if (maximisedParticipant) {
      return (
        <VideoTileContainer
          height={bounds.height}
          width={bounds.width}
          key={maximisedParticipant.id}
          item={maximisedParticipant}
          getAvatar={renderAvatar}
          audioContext={audioContext}
          audioDestination={audioDestination}
          disableSpeakingIndicator={true}
          maximised={Boolean(maximisedParticipant)}
          fullscreen={maximisedParticipant === fullscreenParticipant}
          onFullscreen={toggleFullscreen}
        />
      );
    }

    return (
      <VideoGrid
        items={items}
        layout={layout}
        disableAnimations={prefersReducedMotion || isSafari}
      >
        {({
          item,
          ...rest
        }: {
          item: TileDescriptor;
          [x: string]: unknown;
        }) => (
          <VideoTileContainer
            key={item.id}
            item={item}
            getAvatar={renderAvatar}
            audioContext={audioContext}
            audioDestination={audioDestination}
            disableSpeakingIndicator={items.length < 3}
            maximised={false}
            fullscreen={false}
            onFullscreen={toggleFullscreen}
            {...rest}
          />
        )}
      </VideoGrid>
    );
  };

  const {
    modalState: rageshakeRequestModalState,
    modalProps: rageshakeRequestModalProps,
  } = useRageshakeRequestModal(groupCall.room.roomId);

  const containerClasses = classNames(styles.inRoom, {
    [styles.maximised]: maximisedParticipant,
  });

  return (
    <div className={containerClasses} ref={containerRef}>
      <audio ref={audioRef} />
      {(!spatialAudio || maximisedParticipant) && (
        <AudioContainer
          items={items}
          audioContext={audioContext}
          audioDestination={audioDestination}
        />
      )}
      {!hideHeader && !maximisedParticipant && (
        <Header>
          <LeftNav>
            <RoomHeaderInfo roomName={roomName} avatarUrl={avatarUrl} />
            <VersionMismatchWarning
              users={unencryptedEventsFromUsers}
              room={groupCall.room}
            />
          </LeftNav>
          <RightNav>
            <GridLayoutMenu layout={layout} setLayout={setLayout} />
            <UserMenuContainer preventNavigation />
          </RightNav>
        </Header>
      )}
      {renderContent()}
      <div className={styles.footer}>
        <MicButton muted={microphoneMuted} onPress={toggleMicrophoneMuted} />
        <VideoButton muted={localVideoMuted} onPress={toggleLocalVideoMuted} />
        {canScreenshare &&
          !hideScreensharing &&
          !isSafari &&
          !reducedControls && (
            <ScreenshareButton
              enabled={isScreensharing}
              onPress={toggleScreensharing}
            />
          )}
        {!reducedControls && (
          <OverflowMenu
            inCall
            roomIdOrAlias={roomIdOrAlias}
            groupCall={groupCall}
            showInvite={joinRule === JoinRule.Public}
            feedbackModalState={feedbackModalState}
            feedbackModalProps={feedbackModalProps}
          />
        )}
        <HangupButton onPress={onLeave} />
      </div>
      <GroupCallInspector
        client={client}
        groupCall={groupCall}
        show={showInspector}
      />
      {rageshakeRequestModalState.isOpen && (
        <RageshakeRequestModal
          {...rageshakeRequestModalProps}
          roomIdOrAlias={roomIdOrAlias}
        />
      )}
    </div>
  );
}

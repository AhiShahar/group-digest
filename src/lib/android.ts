// Bridge to the native Android wrapper (android/ in this repo). In a normal
// browser `bridge` is undefined and the web code paths are used instead.
import { eventTimes } from './calendar';
import type { DigestEvent } from './digest';

interface AndroidBridge {
  addToCalendar(title: string, beginMs: number, endMs: number, allDay: boolean, location: string, description: string): void;
  shareText(text: string): void;
  shareFile(name: string, mime: string, content: string): void;
  openExternal(url: string): void;
  takePendingShare(): string; // JSON {name, b64} or ""
  // Live capture from WhatsApp notifications (only in builds that have it)
  captureStatus?(): string; // JSON CaptureStatus
  setCaptureGroups?(json: string): void;
  peekCaptured?(): string; // JSON CapturedMessage[]
  ackCaptured?(): void;
  openCaptureSettings?(): void;
  openAppInfo?(): void;
  androidVersion?(): number;
  // Event reminders as phone notifications
  scheduleReminders?(json: string): void; // ScheduledReminder[]
  cancelReminders?(idPrefix: string): void;
  reminderIds?(): string; // JSON string[] of future reminders
  notificationsAllowed?(): boolean;
  askNotificationPermission?(): void;
  // Live-sync notices, checked about every half hour in the background
  setNoticeWatch?(json: string): void; // {relay, room, secret, after} or "" to stop
}

export interface CaptureStatus {
  enabled: boolean;
  seen: string[];
  selected: string[];
}

export interface CapturedMessage {
  chat: string;
  ts: number;
  sender: string | null;
  text: string;
}

export const bridge: AndroidBridge | undefined = (window as unknown as { AndroidBridge?: AndroidBridge }).AndroidBridge;
export const isAndroidApp = !!bridge;


export function captureStatus(): CaptureStatus | null {
  if (!bridge?.captureStatus) return null;
  try {
    return JSON.parse(bridge.captureStatus()) as CaptureStatus;
  } catch {
    return null;
  }
}

/** False in the browser and in the lite APK, which has no notification access. */
export const canCapture = captureStatus() !== null;

/** Read messages captured since last time. Call ackCaptured() once they are stored. */
export function peekCaptured(): CapturedMessage[] {
  if (!bridge?.peekCaptured) return [];
  try {
    return JSON.parse(bridge.peekCaptured()) as CapturedMessage[];
  } catch {
    return [];
  }
}


export function addEventNative(e: DigestEvent, chatName: string): void {
  const { start, end, allDay } = eventTimes(e);
  const desc = [e.notes, `From WhatsApp group "${chatName}": "${e.source_quote}"`].filter(Boolean).join('\n\n');
  // All-day events use UTC midnight, as Android's calendar provider expects.
  const begin = allDay ? Date.UTC(start.getFullYear(), start.getMonth(), start.getDate()) : start.getTime();
  const finish = allDay ? Date.UTC(end.getFullYear(), end.getMonth(), end.getDate()) : end.getTime();
  bridge!.addToCalendar(e.title, begin, finish, allDay, e.location ?? '', desc);
}

/** A file shared into the app from WhatsApp, waiting to be imported. */
export function takeNativeShare(): File | null {
  if (!bridge) return null;
  const raw = bridge.takePendingShare();
  if (!raw) return null;
  const { name, b64, mime } = JSON.parse(raw) as { name: string; b64: string; mime?: string };
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name || 'shared.txt', { type: mime || '' });
}

/** Send links that would open a new tab to the phone's browser instead. */
export function routeExternalLinks(): void {
  if (!bridge) return;
  document.addEventListener(
    'click',
    (ev) => {
      const a = (ev.target as HTMLElement | null)?.closest?.('a[target=_blank]') as HTMLAnchorElement | null;
      if (!a) return;
      ev.preventDefault();
      bridge.openExternal(a.href);
    },
    true,
  );
}

/** True in the Android app builds that can post reminder notifications. */
export const canRemind = !!bridge?.scheduleReminders;

export function reminderIds(): string[] {
  if (!bridge?.reminderIds) return [];
  try {
    return JSON.parse(bridge.reminderIds()) as string[];
  } catch {
    return [];
  }
}

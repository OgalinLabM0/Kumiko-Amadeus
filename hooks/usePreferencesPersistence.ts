import { useEffect, type MutableRefObject } from 'react';
import { db } from '../services/db';
import {
  MESSAGE_ALERTS_STORAGE_KEY,
  SUMMARY_ARCHIVE_STATE_STORAGE_KEY,
} from '../components/app/appConstants';
import {
  RELATIVE_REMINDER_STORAGE_KEY,
  DAILY_REMINDER_STORAGE_KEY,
  type RelativeReminder,
  type DailyReminder,
} from '../store/slices/reminderSlice';
import type { DiaryLayerPreset } from '../constants/diaryLayerConfig';
import type { ImageQualityPreset } from '../constants/imageQualityConfig';
import type {
  AnchorEntry,
  Language,
  LocationConfig,
  MissedMessageAlert,
  SummaryArchiveState,
  WorldBookEntry,
} from '../types';

export interface UsePreferencesPersistenceParams {
  isDataLoaded: boolean;
  isBulkRestoreInProgressRef: MutableRefObject<boolean>;
  language: Language;
  locationConfig: LocationConfig;
  coreMemory: string;
  kumikoNotebook: string;
  contextLimit: number;
  diaryLayerPreset: DiaryLayerPreset;
  imageQualityPreset: ImageQualityPreset;
  worldBook: WorldBookEntry[];
  turnCount: number;
  summaryArchiveState: SummaryArchiveState;
  relativeReminders: RelativeReminder[];
  dailyReminders: DailyReminder[];
  anchors: AnchorEntry[];
  messageAlerts: MissedMessageAlert[];
}

export function usePreferencesPersistence(params: UsePreferencesPersistenceParams): void {
  const {
    isDataLoaded,
    isBulkRestoreInProgressRef,
    language,
    locationConfig,
    coreMemory,
    kumikoNotebook,
    contextLimit,
    diaryLayerPreset,
    imageQualityPreset,
    worldBook,
    turnCount,
    summaryArchiveState,
    relativeReminders,
    dailyReminders,
    anchors,
    messageAlerts,
  } = params;

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_language', language);
  }, [language, isDataLoaded]);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_location_config', locationConfig);
  }, [locationConfig, isDataLoaded]);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_core_memory', coreMemory);
  }, [coreMemory, isDataLoaded]);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_notebook', kumikoNotebook);
  }, [kumikoNotebook, isDataLoaded]);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_context_limit', contextLimit);
  }, [contextLimit, isDataLoaded]);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_diary_layer_preset', diaryLayerPreset);
  }, [diaryLayerPreset, isDataLoaded]);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_image_quality_preset', imageQualityPreset);
  }, [imageQualityPreset, isDataLoaded]);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_world_book', worldBook);
  }, [worldBook, isDataLoaded]);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_turn_count', turnCount);
  }, [turnCount, isDataLoaded]);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal(SUMMARY_ARCHIVE_STATE_STORAGE_KEY, summaryArchiveState);
  }, [summaryArchiveState, isDataLoaded]);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal(RELATIVE_REMINDER_STORAGE_KEY, relativeReminders);
  }, [relativeReminders, isDataLoaded]);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal(DAILY_REMINDER_STORAGE_KEY, dailyReminders);
  }, [dailyReminders, isDataLoaded]);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal('kumiko_anchors', anchors);
  }, [anchors, isDataLoaded]);

  useEffect(() => {
    if (!isDataLoaded || isBulkRestoreInProgressRef.current) return;
    db.setVal(MESSAGE_ALERTS_STORAGE_KEY, messageAlerts.slice(0, 50));
  }, [messageAlerts, isDataLoaded]);
}

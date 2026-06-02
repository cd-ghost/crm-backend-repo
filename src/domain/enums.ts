import type { DealStage, LeadStatus } from '../types';

export const LEAD_STATUSES: readonly LeadStatus[] = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'LOST',
  'WON',
] as const;

export const DEAL_STAGES: readonly DealStage[] = [
  'PROSPECTING',
  'NEGOTIATION',
  'PROPOSAL',
  'CLOSED_WON',
  'CLOSED_LOST',
] as const;

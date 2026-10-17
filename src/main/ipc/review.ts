import * as db from '../db';
import type { Id, RetroType, ReviewGrade, ReviewSource } from '../../shared/types';
import type { Handle } from './common';

/** 复习卡片、打分、复盘（日/周/月）。 */
export function registerReview(handle: Handle): void {
  handle('review:list', (p: { due?: boolean; source?: ReviewSource; limit?: number }) =>
    db.listReviewCards(p ?? {})
  );
  handle('review:due', () => db.dueReviewCards());
  handle('review:stats', () => db.reviewStats());
  handle('review:create', (p: Parameters<typeof db.createReviewCard>[0]) => db.createReviewCard(p));
  handle('review:from-note', (p: { noteId: Id }) => db.createCardFromNote(p.noteId));
  handle('review:update', (p: { id: Id; patch: Partial<Parameters<typeof db.createReviewCard>[0]> }) => {
    db.updateReviewCard(p.id, p.patch);
    return true;
  });
  handle('review:delete', (p: { id: Id }) => {
    db.deleteReviewCard(p.id);
    return true;
  });
  handle('review:grade', (p: { id: Id; grade: ReviewGrade }) => db.gradeReviewCard(p.id, p.grade));
  handle('review:logs', (p: { cardId: Id }) => db.reviewLogs(p.cardId));

  handle('retro:list', (p: { type?: RetroType }) => db.listRetrospectives(p?.type));
  handle('retro:get', (p: { type: RetroType; date: string }) => db.getRetrospective(p.type, p.date));
  handle('retro:save', (p: { type: RetroType; date: string; content: string }) =>
    db.saveRetrospective(p.type, p.date, p.content)
  );
  handle('retro:delete', (p: { id: Id }) => {
    db.deleteRetrospective(p.id);
    return true;
  });
  handle('retro:period', (p: { type: 'week' | 'month'; date?: string }) => {
    const base = p?.date ? new Date(`${p.date}T12:00:00`) : new Date();
    return db.periodRange(p.type, base);
  });
  handle('retro:stats', (p: { from: string; to: string }) => db.periodStats(p.from, p.to));
}

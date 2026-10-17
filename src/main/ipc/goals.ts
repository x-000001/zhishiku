import * as db from '../db';
import type { Goal, GoalHorizon, GoalPoolItem, Id, KeyResult, Milestone } from '../../shared/types';
import type { Handle } from './common';

/** 当前目标（含关键结果与里程碑）、下一阶段目标池。 */
export function registerGoals(handle: Handle): void {
  handle('goal:list', (p: { includeArchived?: boolean }) => db.listGoals(p?.includeArchived ?? false));
  handle('goal:get', (p: { id: Id }) => db.getGoalDetail(p.id));
  handle('goal:create', (p: { title: string; description?: string; target_date?: string | null }) =>
    db.createGoal(p)
  );
  handle('goal:update', (p: { id: Id; patch: Partial<Goal> }) => {
    db.updateGoal(p.id, p.patch);
    return true;
  });
  handle('goal:delete', (p: { id: Id }) => {
    db.deleteGoal(p.id);
    return true;
  });
  handle('goal:active-count', () => db.activeGoalCount());

  handle('kr:list', (p: { goalId: Id }) => db.listKeyResults(p.goalId));
  handle('kr:create', (p: { goalId: Id } & Parameters<typeof db.createKeyResult>[1]) =>
    db.createKeyResult(p.goalId, p)
  );
  handle('kr:update', (p: { id: Id; patch: Partial<KeyResult> }) => {
    db.updateKeyResult(p.id, p.patch);
    return true;
  });
  handle('kr:delete', (p: { id: Id }) => {
    db.deleteKeyResult(p.id);
    return true;
  });

  handle('milestone:list', (p: { goalId: Id }) => db.listMilestones(p.goalId));
  handle('milestone:create', (p: { goalId: Id; title: string; target_date?: string | null }) =>
    db.createMilestone(p.goalId, p)
  );
  handle('milestone:update', (p: { id: Id; patch: Partial<Milestone> }) => {
    db.updateMilestone(p.id, p.patch);
    return true;
  });
  handle('milestone:toggle', (p: { id: Id; done?: boolean }) => {
    db.toggleMilestone(p.id, p.done);
    return true;
  });
  handle('milestone:delete', (p: { id: Id }) => {
    db.deleteMilestone(p.id);
    return true;
  });

  /* ---------------- 下一阶段目标（第二版） ---------------- */

  handle('pool:list', (p: { horizon?: GoalHorizon }) => db.listGoalPool(p?.horizon));
  handle('pool:create', (p: Parameters<typeof db.createPoolItem>[0]) => db.createPoolItem(p));
  handle('pool:update', (p: { id: Id; patch: Partial<GoalPoolItem> }) => {
    db.updatePoolItem(p.id, p.patch);
    return true;
  });
  handle('pool:delete', (p: { id: Id }) => {
    db.deletePoolItem(p.id);
    return true;
  });
  handle('pool:start', (p: { id: Id }) => db.startPoolItem(p.id));
}

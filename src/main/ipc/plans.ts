import * as db from '../db';
import type { Id, Plan, PlanItem } from '../../shared/types';
import type { Handle } from './common';

/** 学习计划与计划条目、日历。 */
export function registerPlans(handle: Handle): void {
  handle('plan:list', (p: { includeArchived?: boolean }) => db.listPlans(p?.includeArchived ?? false));
  handle('plan:get', (p: { id: Id }) => db.getPlanDetail(p.id));
  handle('plan:create', (p: Parameters<typeof db.createPlan>[0]) => db.createPlan(p));
  handle('plan:update', (p: { id: Id; patch: Partial<Plan> }) => {
    db.updatePlan(p.id, p.patch);
    return true;
  });
  handle('plan:delete', (p: { id: Id }) => {
    db.deletePlan(p.id);
    return true;
  });
  handle('plan-item:list', (p: { planId: Id }) => db.listPlanItems(p.planId));
  handle('plan-item:create', (p: { planId: Id } & Parameters<typeof db.createPlanItem>[1]) =>
    db.createPlanItem(p.planId, p)
  );
  handle('plan-item:update', (p: { id: Id; patch: Partial<PlanItem> }) => {
    db.updatePlanItem(p.id, p.patch);
    return true;
  });
  handle('plan-item:toggle', (p: { id: Id; done?: boolean }) => {
    db.togglePlanItem(p.id, p.done);
    return true;
  });
  handle('plan-item:delete', (p: { id: Id }) => {
    db.deletePlanItem(p.id);
    return true;
  });
  handle('plan:calendar', (p: { from: string; to: string }) => db.calendarEntries(p.from, p.to));
}

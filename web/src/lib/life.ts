export interface LifeHabit {
  id: number;
  name: string;
  category: string;
  target: number;
  unit: string;
  active: boolean;
  value: number;
  note: string;
  complete: boolean;
}

export interface LifeReflection {
  day: string;
  wake_time: string;
  bedtime: string;
  energy: number | null;
  mood: string;
  win: string;
  obstacle: string;
  lesson: string;
  tomorrow: string;
  updated_at: string;
}

export interface LifeTimelineEvent {
  id: number;
  habit_id: number;
  habit_name: string;
  category: string;
  value: number;
  delta: number;
  note: string;
  occurred_at: string;
}

export interface LifeToday {
  day: string;
  income_gate: { open: boolean; message: string };
  totals: { active: number; completed: number };
  habits: LifeHabit[];
  reflection: LifeReflection | null;
  timeline: LifeTimelineEvent[];
}

export interface LifeHistoryDay {
  day: string;
  completed: number;
  active: number;
}

export interface LifeHabitCreate {
  name: string;
  category: string;
  target: number;
  unit: string;
}

export interface LifeHabitUpdate {
  name?: string;
  category?: string;
  target?: number;
  unit?: string;
  active?: boolean;
}

export interface LifeReflectionUpdate {
  wake_time: string;
  bedtime: string;
  energy: number | null;
  mood: string;
  win: string;
  obstacle: string;
  lesson: string;
  tomorrow: string;
}

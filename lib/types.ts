// Shared types matching the Supabase API response shapes

const PRODUCT_LABELS: Record<string, string> = {
  analytics:       "Analytics",
  session_replay:  "Session Replay",
  feature_flags:   "Feature Flags",
  experiments:     "Experiments",
  surveys:         "Surveys",
  data_warehouse:  "Data Warehouse",
  cdp:             "CDP",
  messaging:       "Messaging",
  web_analytics:   "Web Analytics",
  hog:             "HogQL",
  max_ai:          "Max AI",
  infra:           "Infrastructure",
  billing:         "Billing",
  onboarding:      "Onboarding",
};

export function formatProductSlug(slug: string): string {
  return PRODUCT_LABELS[slug] ?? slug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface LeaderboardEngineer {
  author_login: string;
  n_prs_merged: number;
  avg_pr_score: number;
  n_reviews_given: number;
  avg_review_score: number;
  raw_composite: number;
  avg_percentile: number;
  rank: number;
  computed_at: string;
}

export interface TeamBandRow {
  week_start: string;
  n_active: number;
  mean_composite: number;
  p25_composite: number;
  p50_composite: number;
  p75_composite: number;
}

export interface EngineerWeeklyRow {
  author_login: string;
  week_start: string;
  raw_composite: number;
  avg_pr_score: number;
  avg_review_score: number;
  n_prs_merged: number;
  n_reviews: number;
  team_percentile: number;
}

export interface EngineerWeeklyWithBand extends EngineerWeeklyRow {
  team_p25: number | null;
  team_p50: number | null;
  team_p75: number | null;
}

export interface EngineerSummary {
  n_prs: number;
  n_reviews: number;
  avg_pr_score: number;
  avg_review_score: number;
  composite_score: number;
  avg_percentile: number;
  rank: number;
  team_avg_pr_score?: number | null;
  team_avg_review_score?: number | null;
}

export interface Evidence {
  pr_id: string;
  pr_number: number | null;
  title: string | null;
  merged_at: string | null;
  evidence_type: string;
  raw_pr_score: number;
  week_start: string;
  github_url: string | null;
  primary_product: string | null;
  is_public_facing: boolean | null;
  // Rank-based Product Impact Units assigned per PR so that the
  // sum across evidence PRs matches the engineer's composite.
  raw_piu: number;
  // Detailed scoring breakdown for Product Impact Units
  impact_score?: number | null;
  delivery_score?: number | null;
  breadth_score?: number | null;
  category_weight?: number | null;
  pr_category?: string | null;
  complexity_score?: number | null;
  risk_score?: number | null;
  cross_cutting_score?: number | null;
  user_facing_score?: number | null;
  tech_debt_delta?: number | null;
  is_breaking_change?: boolean | null;
  touches_critical_path?: boolean | null;
}

export interface Area {
  area: string;
  n_prs: number;
  n_files_touched: number;
  last_touched_at: string;
}

CREATE TABLE rufa_preferences (
  user_id uuid PRIMARY KEY REFERENCES rufa_users(id), snapshot jsonb NOT NULL
);
CREATE TABLE rufa_preference_mutations (
  user_id uuid NOT NULL REFERENCES rufa_users(id), mutation_id uuid NOT NULL,
  revision bigint NOT NULL, receipt jsonb NOT NULL,
  PRIMARY KEY(user_id,mutation_id), UNIQUE(user_id,revision)
);

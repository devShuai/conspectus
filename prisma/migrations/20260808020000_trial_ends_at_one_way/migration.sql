-- #63: trialEndsAt must be one-way, not a biconditional.
--
-- design.md §6.2 only requires `status='trial'` => `trialEndsAt IS NOT NULL`.
-- The original CHECK also asserted the reverse, which forced the trial
-- conversion in §7.2 to null the field and destroyed the historical fact of
-- when the trial ended (and made occurrenceKey `<id>:<trialEndsAt>`
-- unrecomputable from the row).

ALTER TABLE "subscriptions" DROP CONSTRAINT subscriptions_trial_requires_ends;

ALTER TABLE "subscriptions"
  ADD CONSTRAINT subscriptions_trial_requires_ends CHECK (
    "status" <> 'trial' OR "trialEndsAt" IS NOT NULL
  );

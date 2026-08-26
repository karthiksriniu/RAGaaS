-- 006: make "this mobile was OTP-verified" a fact we record, rather than one
-- inferred from the absence of a row.
--
-- Signup proved verification by checking that no otp_challenges row survived,
-- because verifyOtp deletes the row on success. That is true of a verified
-- number - and equally true of a number that never requested a code at all.
-- Anyone could therefore skip the OTP step entirely and sign up (and, since
-- the payment work, open and claim a payment order) against a mobile they do
-- not own.
--
-- The row now survives verification carrying verified_at, and the checks look
-- for that column instead of for absence.
--
-- Reversible: drop the column. The app code must be rolled back with it,
-- since the new checks require the column to exist.
alter table otp_challenges add column if not exists verified_at timestamptz;

-- Anyone mid-signup right now holds a deleted row and would be bounced back to
-- the code step by the new check. There is no way to tell from here which
-- numbers those were, and the alternative - granting a receipt to every number
-- that ever verified - is exactly the hole being closed. A handful of people
-- re-entering a code is the cheaper mistake.

create index if not exists otp_challenges_verified_idx
  on otp_challenges (mobile, verified_at) where verified_at is not null;

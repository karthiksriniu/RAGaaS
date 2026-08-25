-- 004: retire the "About this business" answer-style block, and collapse the
-- six voice presets to four.
--
-- Both are UPDATEs on existing rows - no DDL - so this can be applied with the
-- app_runtime role, which already holds UPDATE on tenants.
--
-- REVERSIBLE. The About block was only ever a copy of tenants.business_description,
-- which this leaves untouched, so the previous config can be reconstructed from
-- the same source it was generated from.

-- 1. Answer style.
--
-- The block being removed put the owner's one-line signup description into the
-- prompt as instruction-shaped text, where it competed with retrieved knowledge
-- and sometimes won - the agent answering from a vague signup blurb instead of
-- the knowledge base. See src/lib/answerStyle.ts.
--
-- Only rows that still carry the generated heading are touched, so a business
-- that has since written its own guidance keeps it.
update tenants
   set answer_config_md = $style$## Answer style

- Short and crisp. Two or three sentences is the target, and one is often
  enough. A caller cannot skim, so a long answer is harder to follow than two
  short exchanges.
- Lead with the direct answer, then stop. Do not unload everything you know at
  once - it overwhelms the caller and buries the part they actually needed.
- When there is more worth saying, offer it rather than saying it: "There's a
  bit more to it - want me to run through it?", "I can go into the details if
  that helps." Let them choose how deep to go.
- Keep it a conversation, not a recital. End on a short opening for the next
  question rather than a full stop.
- Drop in casual fillers now and then - "sure", "right", "got it", "hmm" - so
  you sound like a person rather than a script. Sparingly: about one reply in
  four, never two in a row.
- Use everyday words and contractions. "That's the one", "no worries", "sure"
  rather than "that is correct", "you are welcome", "certainly".
- Stay within what this business actually does. If asked about something
  unrelated, say so plainly and offer to put them through to a person.$style$
 where answer_config_md like '# About this business%';

-- 2. Voice presets.
--
-- The warm/measured/chirpy variants are gone. Remapped rather than left to fall
-- back at resolve time, so a business that picked a male voice keeps one -
-- silently switching the gender of the voice answering someone's phone is not
-- an acceptable outcome of a tidy-up.
--
-- 'female-energetic' keeps its id and gains the brisker settings; NULL keeps
-- meaning "use the default", which is now female-energetic.
update tenants set voice_preset = 'male-enthusiastic'
 where voice_preset in ('male-warm', 'male-measured', 'male-chirpy');

update tenants set voice_preset = 'female-enthusiastic'
 where voice_preset in ('female-warm', 'female-measured');

-- 3. The same block, where a business has since written its own answer style
--    around it.
--
-- Statement 1 only matches configs that still BEGIN with the generated heading,
-- which is right - it replaces them wholesale, and doing that to something a
-- human wrote would throw their work away. But at least one business kept its
-- own guidance and left the About block sitting underneath, which is the worst
-- version of the problem: a long factual blob in the prompt, competing with the
-- knowledge base on every single answer.
--
-- So this cuts out the block ALONE and leaves everything either side of it
-- untouched. The pattern runs from the heading to the next heading of any level,
-- or to the end of the text when it is the last section.
update tenants
   set answer_config_md = btrim(regexp_replace(
         answer_config_md,
         '(^|\n)#{1,3}[ \t]*About th(is|e) business[ \t]*\n.*?(?=\n#{1,6}[ \t]|$)',
         '', 'gi'))
 where answer_config_md ~* '(^|\n)#{1,3}[ \t]*About th(is|e) business[ \t]*(\n|$)';

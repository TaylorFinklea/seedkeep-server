-- Phase 2C.1: spatial bed layout.
--
-- A planting event can now carry a position within its bed, measured
-- in feet from the bed's bottom-left corner (origin at 0,0). Both
-- columns nullable — many events (a generic "till the bed" note,
-- or a sowing the user hasn't placed yet) stay positionless.
--
-- Stored as feet (not pixels) so the layout renders correctly at any
-- screen size and works for an eventual print/export view. The bed's
-- own width_feet/length_feet (migration 0005) determine the bounds
-- that the client clamps against.

ALTER TABLE planting_events
  ADD COLUMN IF NOT EXISTS x_feet NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS y_feet NUMERIC(5,2);

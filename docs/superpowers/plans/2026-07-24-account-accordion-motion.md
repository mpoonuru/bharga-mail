# Mail Account Accordion Motion Implementation Plan

**Goal:** Add polished, accessible expansion and collapse motion to sidebar mail accounts.

**Architecture:** Keep account selection as the source of truth and animate only
its disclosure and folder presentation. Reuse Motion and existing CSS tokens,
with one shared cubic-bezier transition for the reveal and sibling layout shift.

- [ ] Add a failing test for the shared transition contract.
- [ ] Export the motion contract and verify the focused test passes.
- [ ] Wrap the folder tree in `AnimatePresence` and a measured-height motion container.
- [ ] Rotate the existing disclosure chevron without swapping icons.
- [ ] Add focused styling for the animation wrapper.
- [ ] Run the full frontend tests and production build.

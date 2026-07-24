# Mail account accordion motion

## Objective

Make sidebar mail-account expansion feel modern and spatially coherent without
changing selection, folder loading, reordering, account menus, or sync behavior.

## Interaction

- The disclosure chevron remains mounted and rotates between 0 and 90 degrees.
- The folder region stays mounted and uses a CSS grid row to transition between
  `0fr` and `1fr`, allowing sibling accounts to move in normal document flow.
- Expansion uses a restrained 180 ms `cubic-bezier(0.2, 0.8, 0.2, 1)` curve.
- Opacity and a two-pixel vertical offset provide a quiet sense of direction
  without bounce, overshoot, or stagger.
- The chevron rotates over 160 ms with the same easing family.
- The account button preserves `aria-expanded`; collapsed folder controls are
  hidden from assistive technology and keyboard navigation.
- Global reduced-motion styling collapses animation duration for users who
  request it.

## Safety

The disclosure wraps the existing folder tree without changing its contents or
callbacks. The account row no longer runs a separate layout transition during
expansion: the grid row changes height in normal flow, so displaced sibling
accounts follow the same physical movement instead of receiving a second Motion
transform. The inner wrapper clips content while collapsed and becomes visible
when expanded so folder menus are not cut off.

## Verification

A focused unit test locks the disclosure timing contract and the absence of a
spring transition. The full frontend and Rust test suites, production build,
native bundle, reduced-motion check, and manual open/close exercise verify the
component and desktop integration.

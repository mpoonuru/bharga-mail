# Mail account accordion motion

## Objective

Make sidebar mail-account expansion feel modern and spatially coherent without
changing selection, folder loading, reordering, account menus, or sync behavior.

## Interaction

- The disclosure chevron remains mounted and rotates between 0 and 90 degrees.
- The folder region animates height from zero to its measured content height
  with a deterministic `cubic-bezier(0.22, 1, 0.36, 1)` curve.
- Opacity and a four-pixel vertical offset reinforce the expansion direction.
- Closing reverses the motion before unmounting the folder controls.
- The animation uses the existing Motion dependency and preserves
  `aria-expanded`.
- Global reduced-motion styling collapses animation duration for users who
  request it.

## Safety

The animation wraps the existing folder tree without changing its contents or
callbacks. Account-row layout movement uses the same cubic-bezier transition as
the expanding region, preventing the folder reveal and displaced sibling rows
from moving on competing curves. Overflow is clipped only during the transition
and becomes visible after expansion so folder menus are not cut off.

## Verification

A focused unit test locks the shared transition contract. The full frontend test
suite and production build verify the component and TypeScript integration.

# sharp stub (no native addon)

In-repo stand-in for [`sharp`](https://github.com/lovell/sharp) so `@xenova/transformers` can install on a locked-down Windows workstation.

- No `.node` binary, no `install` script, no libvips download
- Default export is truthy so Transformers.js loads (it `import`s `sharp` from `utils/image.js` even for text models)
- Image operations reject with a clear error

Root `package.json` overrides every `sharp` dependency to this folder. Do not replace this with the real native package.

// Settings are named ODY_* (the product is Ody). The older MENTOR_* names still work: this copies each ODY_* value onto
// its MENTOR_* twin (which the code reads) unless the MENTOR_* one is set explicitly. Import this first in every entry.
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('ODY_')) {
    const old = 'MENTOR_' + k.slice(4);
    if (process.env[old] === undefined) process.env[old] = v;
  }
}

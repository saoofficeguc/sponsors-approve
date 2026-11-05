// Where the site finds its server.
// On GitHub Pages the pages and the server are separate: the server is the "sponsors" Supabase Edge Function.
// Anywhere else (node server.js) the server is the same address as the pages.
// To use a different Supabase project, change the project ref here and in .github/workflows/*.yml.
window.SP_API = /\.github\.io$/.test(location.hostname)
  ? 'https://chrgfpssxaapsghcgxql.supabase.co/functions/v1/sponsors'
  : '';

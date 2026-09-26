/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** Set by src/middleware.ts on every /dashboard and non-public /api request. */
    principal?: import('./types').Principal;
  }
}

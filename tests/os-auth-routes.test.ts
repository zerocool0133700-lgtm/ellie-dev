import { describe, test, expect } from "bun:test"
import {
  parseOsAuthRoute,
  type OsAuthRouteMatch,
} from "../src/os-auth/index"

describe("os-auth route parsing", () => {
  test("matches POST /api/os-auth/register", () => {
    const match = parseOsAuthRoute("/api/os-auth/register", "POST")
    expect(match).toEqual({ handler: "register", method: "POST" })
  })

  test("matches POST /api/os-auth/login", () => {
    const match = parseOsAuthRoute("/api/os-auth/login", "POST")
    expect(match).toEqual({ handler: "login", method: "POST" })
  })

  test("matches POST /api/os-auth/refresh", () => {
    const match = parseOsAuthRoute("/api/os-auth/refresh", "POST")
    expect(match).toEqual({ handler: "refresh", method: "POST" })
  })

  test("matches GET /api/os-auth/me", () => {
    const match = parseOsAuthRoute("/api/os-auth/me", "GET")
    expect(match).toEqual({ handler: "me", method: "GET" })
  })

  test("matches GET /.well-known/jwks.json", () => {
    const match = parseOsAuthRoute("/.well-known/jwks.json", "GET")
    expect(match).toEqual({ handler: "jwks", method: "GET" })
  })

  test("returns null for non-matching routes", () => {
    expect(parseOsAuthRoute("/api/bridge/read", "POST")).toBeNull()
    expect(parseOsAuthRoute("/api/os-auth/register", "GET")).toBeNull()
  })
})

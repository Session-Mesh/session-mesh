// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {acceptDemoCatalogWith, assertDemoCatalogToken} from "./catalog-v1.mjs";
import {decodeAdmissionRecordV3, RUNTIME_PROFILE_V3} from "./admission-record-v3.mjs";
export {assertDemoCatalogToken};
export function acceptDemoCatalogV3(bytes, expectedIdentity, admit) {
  if (typeof admit !== "function") throw Error("invalid_runtime_factory");
  return acceptDemoCatalogWith(bytes, expectedIdentity, decodeAdmissionRecordV3, RUNTIME_PROFILE_V3, admit);
}

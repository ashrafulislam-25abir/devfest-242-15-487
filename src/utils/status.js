export const STATUSES = {
  MISSING: 'MISSING',
  EXPIRY_DATE_NEEDED: 'EXPIRY_DATE_NEEDED',
  EXPIRED: 'EXPIRED',
  NOT_PROVIDED: 'NOT_PROVIDED',
  OK: 'OK'
};

export function determineStatus(requirement, matchedFile, expiryDateStr, submissionDeadlineStr) {
  if (!matchedFile) {
    if (requirement.mandatory) {
      return STATUSES.MISSING;
    } else {
      return STATUSES.NOT_PROVIDED;
    }
  }

  if (requirement.has_expiry) {
    if (!expiryDateStr) {
      return STATUSES.EXPIRY_DATE_NEEDED;
    }
    if (expiryDateStr < submissionDeadlineStr) {
      return STATUSES.EXPIRED;
    }
    return STATUSES.OK;
  }

  return STATUSES.OK;
}

export function isBlocking(status) {
  return [STATUSES.MISSING, STATUSES.EXPIRY_DATE_NEEDED, STATUSES.EXPIRED].includes(status);
}

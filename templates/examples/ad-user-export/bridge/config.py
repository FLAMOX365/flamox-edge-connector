"""
AD Bridge API - Configuration
"""

import os

# =============================================================================
# Active Directory connection
# =============================================================================

AD_SERVER = os.environ.get("AD_SERVER", "ldap://localhost")
AD_BASE_DN = os.environ.get("AD_BASE_DN", "DC=example,DC=com")
AD_BIND_USER = os.environ.get("AD_BIND_USER", "")
AD_BIND_PASSWORD = os.environ.get("AD_BIND_PASSWORD", "")
AD_USE_TLS = os.environ.get("AD_USE_TLS", "false").lower() == "true"
AD_CERT_FILE = os.environ.get("AD_CERT_FILE", "")

# =============================================================================
# API authentication
# =============================================================================

BRIDGE_API_TOKEN = os.environ.get("BRIDGE_API_TOKEN", "")

# =============================================================================
# LDAP Attribute
# =============================================================================

# Attributes fetched for users
USER_ATTRIBUTES = [
    # Identification
    "sAMAccountName",
    "userPrincipalName",
    "distinguishedName",
    # Name
    "displayName",
    "givenName",
    "sn",
    "cn",
    # Contact
    "mail",
    "telephoneNumber",
    "mobile",
    "facsimileTelephoneNumber",
    # Organization
    "department",
    "title",
    "company",
    "manager",
    "directReports",
    "physicalDeliveryOfficeName",
    # Groups
    "memberOf",
    # Status
    "userAccountControl",
    "lastLogon",
    "lastLogonTimestamp",
    "whenCreated",
    "whenChanged",
    "accountExpires",
    # Internal IDs (removed by the response hook)
    "objectGUID",
    "objectSid",
]

# Attributes fetched for groups
GROUP_ATTRIBUTES = [
    "cn",
    "distinguishedName",
    "description",
    "member",
    "memberOf",
    "managedBy",
    "groupType",
    "whenCreated",
    "whenChanged",
]

# =============================================================================
# Limits
# =============================================================================

# Maximum number of results per request
MAX_RESULTS = 1000

# Default limit when none is provided
DEFAULT_LIMIT = 100

# Timeout for LDAP operations (seconds)
LDAP_TIMEOUT = 30


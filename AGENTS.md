# Repository Instructions

## Company and product names

- The company and platform name is written exactly as `FLAMOX365`.
- The connector product name is written exactly as `Edge Connector`.
- Never combine both names into one product name.
- Use the appropriate name in every user-facing or human-readable context,
  including UI text, translations, documentation, examples, application names,
  publisher names, schemas, API descriptions and release material.
- Existing lowercase technical identifiers may remain unchanged only where
  changing them would break compatibility or established tooling. This includes
  logs, console prefixes, environment-variable prefixes, package scopes,
  repository and container names, import specifiers, persisted keys, API paths,
  schema identifiers, media types and application identifiers.
- Do not introduce new lowercase technical brand identifiers. Prefer
  domain-oriented, brand-neutral names when defining new technical contracts.
- Internal variables may retain an established technical identifier when it
  makes their integration purpose clearer.
- Do not add the brand as a prefix to source file names, classes, interfaces,
  types or other code symbols. Name code after the smallest unambiguous domain
  concept.
- Before completing a change, search the complete affected tree for company and
  product names. Correct every human-readable occurrence that does not use the
  appropriate exact name and explicitly verify that every remaining technical
  occurrence is justified.

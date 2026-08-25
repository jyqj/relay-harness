/** Versioned, read-only diagnostics shared by the host route and client. */
export declare const DIAGNOSTIC_SCHEMA: 'rlh-market/diagnostics/v1';
/** Conservative first set of known, identity-sensitive host contracts. */
export declare const KNOWN_SHARED_HOST_PACKAGES: readonly ['@relay-harness/cordis', '@relay-harness/rlh-attachment', '@relay-harness/rlh-llm', '@relay-harness/rlh-system-prompt', '@relay-harness/rlh-tools'];
export interface PackageManifestFact {
    packageName: string;
    manifest: unknown;
}
export interface SharedHostPackageDependencyFinding {
    code: 'shared-host-package-dependency';
    severity: 'warning';
    subject: {
        kind: 'package';
        name: string;
    };
    evidence: {
        basis: 'manifest-declaration';
        dependency: string;
        declaredRange: string;
        declaredIn: 'dependencies';
    };
}
export type DiagnosticFinding = SharedHostPackageDependencyFinding;
export interface DiagnosticReportV1 {
    schema: typeof DIAGNOSTIC_SCHEMA;
    findings: DiagnosticFinding[];
}
/** Build a stable diagnostic envelope from installed package manifests. */
export declare function diagnosePackageManifests(packages: readonly PackageManifestFact[]): DiagnosticReportV1;

import { google, tagmanager_v2 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

export interface GTMAccount {
  accountId: string;
  name: string;
  shareData: boolean;
}

export interface GTMContainer {
  accountId: string;
  containerId: string;
  name: string;
  publicId: string; // GTM-XXXXXX
  usageContext: string[];
}

export interface GTMWorkspace {
  accountId: string;
  containerId: string;
  workspaceId: string;
  name: string;
  description?: string;
}

export class GTMClient {
  private gtm: tagmanager_v2.Tagmanager;

  constructor(auth: OAuth2Client) {
    this.gtm = google.tagmanager({ version: 'v2', auth });
  }

  async listAccounts(): Promise<GTMAccount[]> {
    const res = await this.gtm.accounts.list();
    return (res.data.account || []).map(a => ({
      accountId: a.accountId!,
      name: a.name!,
      shareData: a.shareData || false,
    }));
  }

  async listContainers(accountId: string): Promise<GTMContainer[]> {
    const res = await this.gtm.accounts.containers.list({
      parent: `accounts/${accountId}`,
    });
    return (res.data.container || [])
      .filter(c => c.usageContext?.includes('web'))
      .map(c => ({
        accountId: accountId,
        containerId: c.containerId!,
        name: c.name!,
        publicId: c.publicId!,
        usageContext: c.usageContext || [],
      }));
  }

  async listWorkspaces(accountId: string, containerId: string): Promise<GTMWorkspace[]> {
    const res = await this.gtm.accounts.containers.workspaces.list({
      parent: `accounts/${accountId}/containers/${containerId}`,
    });
    return (res.data.workspace || []).map(w => ({
      accountId,
      containerId,
      workspaceId: w.workspaceId!,
      name: w.name!,
      description: w.description ?? undefined,
    }));
  }

  async createWorkspace(
    accountId: string,
    containerId: string,
    name: string,
    description?: string
  ): Promise<GTMWorkspace> {
    const res = await this.gtm.accounts.containers.workspaces.create({
      parent: `accounts/${accountId}/containers/${containerId}`,
      requestBody: { name, description },
    });
    const w = res.data;
    return {
      accountId,
      containerId,
      workspaceId: w.workspaceId!,
      name: w.name!,
      description: w.description ?? undefined,
    };
  }

  async createTag(
    accountId: string,
    containerId: string,
    workspaceId: string,
    tag: tagmanager_v2.Schema$Tag
  ): Promise<tagmanager_v2.Schema$Tag> {
    const res = await this.gtm.accounts.containers.workspaces.tags.create({
      parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      requestBody: tag,
    });
    return res.data;
  }

  async createTrigger(
    accountId: string,
    containerId: string,
    workspaceId: string,
    trigger: tagmanager_v2.Schema$Trigger
  ): Promise<tagmanager_v2.Schema$Trigger> {
    const res = await this.gtm.accounts.containers.workspaces.triggers.create({
      parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      requestBody: trigger,
    });
    return res.data;
  }

  async createVariable(
    accountId: string,
    containerId: string,
    workspaceId: string,
    variable: tagmanager_v2.Schema$Variable
  ): Promise<tagmanager_v2.Schema$Variable> {
    const res = await this.gtm.accounts.containers.workspaces.variables.create({
      parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      requestBody: variable,
    });
    return res.data;
  }

  async updateTag(
    accountId: string,
    containerId: string,
    workspaceId: string,
    tagId: string,
    tag: tagmanager_v2.Schema$Tag
  ): Promise<tagmanager_v2.Schema$Tag> {
    const res = await this.gtm.accounts.containers.workspaces.tags.update({
      path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/tags/${tagId}`,
      requestBody: tag,
    });
    return res.data;
  }

  async updateTrigger(
    accountId: string,
    containerId: string,
    workspaceId: string,
    triggerId: string,
    trigger: tagmanager_v2.Schema$Trigger
  ): Promise<tagmanager_v2.Schema$Trigger> {
    const res = await this.gtm.accounts.containers.workspaces.triggers.update({
      path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/triggers/${triggerId}`,
      requestBody: trigger,
    });
    return res.data;
  }

  async updateVariable(
    accountId: string,
    containerId: string,
    workspaceId: string,
    variableId: string,
    variable: tagmanager_v2.Schema$Variable
  ): Promise<tagmanager_v2.Schema$Variable> {
    const res = await this.gtm.accounts.containers.workspaces.variables.update({
      path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/variables/${variableId}`,
      requestBody: variable,
    });
    return res.data;
  }

  async listTags(accountId: string, containerId: string, workspaceId: string): Promise<tagmanager_v2.Schema$Tag[]> {
    const res = await this.gtm.accounts.containers.workspaces.tags.list({
      parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
    });
    return res.data.tag || [];
  }

  async listTriggers(accountId: string, containerId: string, workspaceId: string): Promise<tagmanager_v2.Schema$Trigger[]> {
    const res = await this.gtm.accounts.containers.workspaces.triggers.list({
      parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
    });
    return res.data.trigger || [];
  }

  async listVariables(accountId: string, containerId: string, workspaceId: string): Promise<tagmanager_v2.Schema$Variable[]> {
    const res = await this.gtm.accounts.containers.workspaces.variables.list({
      parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
    });
    return res.data.variable || [];
  }

  async deleteTag(accountId: string, containerId: string, workspaceId: string, tagId: string): Promise<void> {
    await this.gtm.accounts.containers.workspaces.tags.delete({
      path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/tags/${tagId}`,
    });
  }

  async deleteTrigger(accountId: string, containerId: string, workspaceId: string, triggerId: string): Promise<void> {
    await this.gtm.accounts.containers.workspaces.triggers.delete({
      path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/triggers/${triggerId}`,
    });
  }

  async deleteVariable(accountId: string, containerId: string, workspaceId: string, variableId: string): Promise<void> {
    await this.gtm.accounts.containers.workspaces.variables.delete({
      path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/variables/${variableId}`,
    });
  }

  async createPreviewVersion(
    accountId: string,
    containerId: string,
    workspaceId: string
  ): Promise<{ previewUrl: string; versionId: string }> {
    // Create a container version for preview
    const res = await this.gtm.accounts.containers.workspaces.create_version({
      path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      requestBody: {
        name: `Preview - ${new Date().toISOString()}`,
        notes: 'Auto-generated preview version by event-tracking-skill',
      },
    });

    const versionId = res.data.containerVersion?.containerVersionId || '0';

    // Generate preview URL using quick preview
    const quickPreview = await this.gtm.accounts.containers.workspaces.quick_preview({
      path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
    });

    const previewUrl = quickPreview.data.syncStatus?.syncError
      ? ''
      : `https://tagmanager.google.com/#/container/accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/preview`;

    return { previewUrl, versionId };
  }

  async quickPreview(
    accountId: string,
    containerId: string,
    workspaceId: string
  ): Promise<{ previewAuthorization: string | null }> {
    const res = await this.gtm.accounts.containers.workspaces.quick_preview({
      path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
    });

    return {
      previewAuthorization: (res.data as any).previewAuthorization || null,
    };
  }

  /**
   * Get the GTM preview environment auth code and env ID for a workspace.
   * GTM client-side preview requires ?gtm_preview=env-X&gtm_auth=CODE in the page URL.
   * The "preview" type environment corresponds to the current workspace state.
   */
  async getPreviewEnvironment(
    accountId: string,
    containerId: string,
    workspaceId: string
  ): Promise<{ gtmAuth: string; gtmPreview: string }> {
    const res = await this.gtm.accounts.containers.environments.list({
      parent: `accounts/${accountId}/containers/${containerId}`,
    });

    const environments = res.data.environment || [];

    // First: find a workspace-type environment matching the current workspaceId
    const workspaceEnv = environments.find(
      e => e.type === 'workspace' && (e as any).workspaceId === workspaceId
    );
    if (workspaceEnv?.environmentId) {
      // Reauthorize to get a fresh auth code reflecting the current workspace state
      const reauth = await this.gtm.accounts.containers.environments.reauthorize({
        path: `accounts/${accountId}/containers/${containerId}/environments/${workspaceEnv.environmentId}`,
        requestBody: {},
      });
      return {
        gtmAuth: reauth.data.authorizationCode!,
        gtmPreview: `env-${workspaceEnv.environmentId}`,
      };
    }

    // Not found — create a workspace-type environment for this workspace
    const created = await this.gtm.accounts.containers.environments.create({
      parent: `accounts/${accountId}/containers/${containerId}`,
      requestBody: {
        name: `Preview Environment ${workspaceId} ${new Date().toISOString().replace('T', ' ').slice(0, 16)}`,
        description: 'Created by event-tracking-skill for preview verification',
        type: 'workspace',
        workspaceId,
      } as any,
    });

    if (!created.data.authorizationCode || !created.data.environmentId) {
      throw new Error('Failed to create preview environment: missing authorizationCode or environmentId');
    }

    return {
      gtmAuth: created.data.authorizationCode,
      gtmPreview: `env-${created.data.environmentId}`,
    };
  }

  async enableBuiltInVariables(
    accountId: string,
    containerId: string,
    workspaceId: string,
    types: string[]
  ): Promise<void> {
    try {
      await (this.gtm.accounts.containers.workspaces as any).built_in_variables.create({
        parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
        type: types,
      });
    } catch (err) {
      // Ignore if already enabled
      const msg = (err as Error).message || '';
      if (!msg.includes('already') && !msg.includes('duplicate')) {
        console.warn(`  ⚠️  Built-in variables enable warning: ${msg}`);
      }
    }
  }

  async publishContainer(
    accountId: string,
    containerId: string,
    workspaceId: string,
    versionName?: string
  ): Promise<{ versionId: string; published: boolean }> {
    // First create a version
    const versionRes = await this.gtm.accounts.containers.workspaces.create_version({
      path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      requestBody: {
        name: versionName || `Published - ${new Date().toISOString()}`,
        notes: 'Published by event-tracking-skill',
      },
    });

    const versionId = versionRes.data.containerVersion?.containerVersionId!;

    // Then publish
    await this.gtm.accounts.containers.versions.publish({
      path: `accounts/${accountId}/containers/${containerId}/versions/${versionId}`,
    });

    return { versionId, published: true };
  }
}

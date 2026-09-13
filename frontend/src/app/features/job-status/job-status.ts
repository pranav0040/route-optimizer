import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';

import type { JobStatusResponse } from '../../models/api.models';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-job-status',
  imports: [FormsModule],
  templateUrl: './job-status.html',
  styleUrl: './job-status.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class JobStatusComponent {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly jobId = signal('');
  protected readonly job = signal<JobStatusResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const id = params.get('id');

      if (id) {
        this.jobId.set(id);
        this.lookup();
      }
    });
  }

  protected lookup() {
    const id = this.jobId().trim();

    if (!id) {
      this.errorMessage.set('Enter a job ID to check its status.');
      return;
    }

    this.loading.set(true);
    this.errorMessage.set(null);
    this.job.set(null);
    this.api
      .pollJobUntilComplete(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (job) => {
          this.job.set(job);
          this.loading.set(false);

          if (job.status === 'failed') {
            this.errorMessage.set(job.error_reason ?? 'The optimization job failed.');
          }
        },
        error: (error: unknown) => {
          const message =
            error instanceof HttpErrorResponse
              ? (error.error?.error?.message as string | undefined)
              : undefined;

          this.errorMessage.set(message ?? 'Could not retrieve this job.');
          this.loading.set(false);
        },
      });
  }
}

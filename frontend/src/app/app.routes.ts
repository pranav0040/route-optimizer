import { Routes } from '@angular/router';

import { JobStatusComponent } from './features/job-status/job-status';
import { RouteBuilderComponent } from './features/route-builder/route-builder';

export const routes: Routes = [
  { path: '', component: RouteBuilderComponent, title: 'Route Builder · Route Optimizer' },
  { path: 'jobs', component: JobStatusComponent, title: 'Job Status · Route Optimizer' },
  { path: '**', redirectTo: '' },
];

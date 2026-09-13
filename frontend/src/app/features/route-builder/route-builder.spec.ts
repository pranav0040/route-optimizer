import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { ApiService } from '../../services/api.service';
import { RouteBuilderComponent } from './route-builder';

describe('RouteBuilderComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RouteBuilderComponent],
      providers: [
        provideRouter([]),
        {
          provide: ApiService,
          useValue: jasmine.createSpyObj<ApiService>('ApiService', [
            'optimize',
            'pollJobUntilComplete',
          ]),
        },
      ],
    }).compileComponents();
  });

  it('adds a stop from the route form', () => {
    const fixture = TestBed.createComponent(RouteBuilderComponent);

    fixture.detectChanges();
    expect(stopRows(fixture.nativeElement)).toBe(2);

    button(fixture.nativeElement, '[data-testid="add-stop"]').click();
    fixture.detectChanges();

    expect(stopRows(fixture.nativeElement)).toBe(3);
  });

  it('removes the selected stop from the route form', () => {
    const fixture = TestBed.createComponent(RouteBuilderComponent);

    fixture.detectChanges();
    const removeButtons = (
      fixture.nativeElement as HTMLElement
    ).querySelectorAll<HTMLButtonElement>('[data-testid="remove-stop"]');

    removeButtons[0].click();
    fixture.detectChanges();

    expect(stopRows(fixture.nativeElement)).toBe(1);
  });
});

function stopRows(element: HTMLElement) {
  return element.querySelectorAll('[data-testid="stop-row"]').length;
}

function button(element: HTMLElement, selector: string) {
  const result = element.querySelector<HTMLButtonElement>(selector);

  if (!result) {
    throw new Error(`Could not find ${selector}`);
  }

  return result;
}
